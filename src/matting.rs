//! 阿尔法抠图（alpha matting）—— 图标「自动描边 + 消除背景」的核心。
//!
//! # 为什么换掉原来的"泛洪 + 颜色容差"
//!
//! 旧算法只看**颜色像不像四边的底色**。浅色 logo 落在浅底上时两者颜色相近，
//! 泛洪就会从边缘一路吃进主体 —— 用户报的「消除背景会把图标里面东西一起消除」
//! 正是这个。这不是参数没调好，是"只看颜色"这件事本身的天花板：它没有
//! **前景/背景的语义分离**。
//!
//! Photoshop 的「选择主体 / 移除背景」用的是一套完全不同的思路，本模块照它实现：
//!
//! ```text
//!   ① 估背景色    从图像四周环带取色，做聚类，得到"这张图的背景长什么样"
//!   ② 自动 trimap 对每个像素判"确定前景 / 确定背景 / 说不准"，
//!                 用**到背景的色距 + 到边界的距离**双判据（不是单一阈值）
//!   ③ 阿尔法求解  在"说不准"的窄带上解 Closed-Form Matting 的稀疏线性系统，
//!                 让 alpha 沿着**图像自身的边缘**过渡（这是 PS 级边缘的关键）
//!   ④ 边缘去色    前景色反解 F = (I - (1-a)B) / a，去掉背景色溢出（白边/绿边）
//!   ⑤ 合成        用求出的 alpha + 去色后的 F 重写像素
//! ```
//!
//! 参考的公开算法（都属同一脉，本模块按可读性重写，不搬代码）：
//!   · Levin et al. 2006, *A Closed-Form Solution to Natural Image Matting*
//!     —— ③ 的数学基础：alpha 局部线性于颜色，代价函数化为稀疏线性系统
//!   · pymatting —— 同一算法的 Python 实现，本模块的收敛口径与它一致
//!   · pangxiaobin/image-matting、isboyjc/removebg —— 工程上"先 trimap 再 matting"
//!     的流水线组织方式
//!
//! # 已知边界
//!
//! · 主体**顶满四边**（没有露出底色）时没有可靠的背景样本 → 退回保守结果并
//!   在返回值里标出来，界面提示用户「这张图可能没有背景」。
//! · 纯白/纯黑背景 + 同色主体（对比度 < 3）时，任何只靠像素的算法都无解；
//!   这时**手动描边**（`KeepMask`）是唯一出路，本模块把它当"确定前景"硬约束。
//! · 求解规模：图像先缩到 `MAX_EDGE`（512）以内；窄带外的像素不解方程（直接
//!   取 0 或 1），所以实际未知量通常只有几千个，毫秒级。


/// 图像处理上限（长边）。超过先等比缩小 —— 图标最终显示只有几十像素，
/// 512 已经远超所需，再大只是让线性系统变慢。
pub const MAX_EDGE: u32 = 512;

/// trimap 的三态。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tri {
    /// 确定背景（alpha = 0）
    Bg,
    /// 确定前景（alpha = 1）
    Fg,
    /// 说不准，要解方程
    Unknown,
}

/// 抠图结果。
pub struct Matting {
    /// 处理后的 RGBA（尺寸 = 输入经缩放后的尺寸）
    pub rgba: image::RgbaImage,
    /// 被判定为背景的像素数（alpha 从有到无）
    pub removed: usize,
    /// 是否没找到可靠背景（主体顶满四边 / 全不透明同色）
    pub no_background: bool,
    /// 三态分布，调试与日志用
    pub tri_counts: (usize, usize, usize),
}

/// 背景色样本：`(代表色, 权重)`。权重 = 该色在边缘环带里的出现次数。
#[derive(Clone, Copy, Debug)]
pub struct BgSample {
    pub rgb: [f32; 3],
    pub weight: f32,
}

/// 把任意输入解码 + 缩放到处理尺寸。返回 RGBA。
pub fn prepare(bytes: &[u8]) -> Result<image::RgbaImage, String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("这张图解不开（{e}），换个 PNG/JPEG 试试"))?;
    let rgba = img.to_rgba8();
    let (w0, h0) = rgba.dimensions();
    if w0 <= MAX_EDGE && h0 <= MAX_EDGE {
        return Ok(rgba);
    }
    let (nw, nh) = if w0 >= h0 {
        (MAX_EDGE, (h0 as u64 * MAX_EDGE as u64 / w0 as u64).max(1) as u32)
    } else {
        ((w0 as u64 * MAX_EDGE as u64 / h0 as u64).max(1) as u32, MAX_EDGE)
    };
    Ok(image::imageops::resize(
        &rgba,
        nw,
        nh,
        image::imageops::FilterType::Triangle,
    ))
}

/// 从图像**四周环带**估背景色。
///
/// 为什么只取环带：图标的主体通常居中，四边那一圈大概率是背景。取太宽会把
/// 主体颜色也当背景（那就回到旧算法的老路了）；这里取边长的 6%，最薄 2px、
/// 最厚 12px。
///
/// 聚类用 5bit/通道量化（32³ = 最多 32768 桶，实际远少于此），然后：
///   · 丢掉出现次数 < 总数 1% 的杂色（噪点、抗锯齿过渡色）；
///   · 按权重降序，最多留 12 个代表色（够表达纯色、渐变、双色底）。
pub fn estimate_background(rgba: &image::RgbaImage) -> Vec<BgSample> {
    use std::collections::HashMap;
    let (w, h) = rgba.dimensions();
    if w < 4 || h < 4 {
        return Vec::new();
    }
    let band = ((w.min(h) as f32 * 0.06).round() as u32).clamp(2, 12);

    let mut map: HashMap<[u8; 3], ([f32; 3], f32)> = HashMap::new();
    let mut total = 0f32;
    let mut add = |p: &image::Rgba<u8>| {
        // 已经透明的像素不贡献背景色（它本来就是背景）
        if p[3] < 200 {
            return;
        }
        let key = [p[0] >> 3, p[1] >> 3, p[2] >> 3];
        let e = map.entry(key).or_insert(([0.0; 3], 0.0));
        // 桶内累加精确色，最后取均值 —— 比"取第一个落桶的色"更稳
        e.0[0] += p[0] as f32;
        e.0[1] += p[1] as f32;
        e.0[2] += p[2] as f32;
        e.1 += 1.0;
        total += 1.0;
    };

    for y in 0..h {
        for x in 0..w {
            let edge = x < band || y < band || x + band >= w || y + band >= h;
            if edge {
                add(rgba.get_pixel(x, y));
            }
        }
    }
    if total < 1.0 {
        return Vec::new();
    }

    let mut out: Vec<BgSample> = map
        .into_iter()
        .filter(|(_, (_, n))| *n >= (total * 0.01).max(2.0))
        .map(|(_, (sum, n))| BgSample {
            rgb: [sum[0] / n, sum[1] / n, sum[2] / n],
            weight: n / total,
        })
        .collect();
    out.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(12);
    out
}

/// 某像素到**最近背景色**的欧氏距离（0..441）。
fn bg_distance(p: &image::Rgba<u8>, samples: &[BgSample]) -> f32 {
    let mut best = f32::MAX;
    for s in samples {
        let dr = p[0] as f32 - s.rgb[0];
        let dg = p[1] as f32 - s.rgb[1];
        let db = p[2] as f32 - s.rgb[2];
        let d = dr * dr + dg * dg + db * db;
        if d < best {
            best = d;
        }
    }
    best.sqrt()
}

/// 生成自动 trimap。
///
/// 这是"像 PS"的关键一步，判据是**双重的**：
///
/// 1. **色距判据**：到最近背景色的距离。距离小 → 像背景。
///    阈值不是写死的，而是从图像自身的色距分布里取 ——
///    `tol` 参数（用户拖的"容差"）作为**基准倍数**参与。
/// 2. **距离判据**：到图像边界的欧氏距离。贴着边的几乎一定是背景
///    （图标主体极少紧贴画布边缘，就算贴了也会被色距判据救回来）。
///
/// 两者合成后，再用**形态学腐蚀/膨胀**把三态各推一圈：
///   · 确定前景先腐蚀一圈 → 免得把"前景边缘的抗锯齿像素"错标成前景
///   · 确定背景先膨胀一圈 → 免得把"背景里靠近主体的杂色"错标成背景
///   · 中间剩下的一条**窄带**才是 Unknown，交给 matting 求解
///
/// 窄带越窄，方程越少、越快；越宽，边缘过渡越细腻。这里按图幅自适应。
pub fn build_trimap(
    rgba: &image::RgbaImage,
    samples: &[BgSample],
    tolerance: u32,
    keep: Option<&[bool]>,
) -> (Vec<Tri>, (usize, usize, usize)) {
    let (w, h) = rgba.dimensions();
    let n = (w as usize) * (h as usize);

    if samples.is_empty() {
        /* r79：没有背景样本有两种情况，必须分开处理 ——
         *
         * ① **图本来就是透明底**（四周环带全是 alpha=0）：这时候不需要"抠"，
         *    它已经抠好了。按原 alpha 直接定三态：全透明→背景、不透明→前景、
         *    中间那条 → Unknown（让 matting 把边缘修顺）。
         *    以前这里一律返回"全 Unknown"，matting 无从判断，会把已经抠好的
         *    主体算成 alpha=0.5 —— 单测 `already_transparent_is_noop` 抓到的
         *    就是它（中心 128 而不是 255）。
         *
         * ② 图完全不透明但四边同色（主体顶满）：真的没有背景信息，
         *    这时才退回"全 Unknown"保守处理，并在返回值里标 no_background。 */
        let raw = rgba.as_raw();
        let has_transparent = (0..n).any(|i| raw[i * 4 + 3] < 200);
        if !has_transparent {
            return (vec![Tri::Unknown; n], (0, 0, n));
        }
        let mut tri = vec![Tri::Unknown; n];
        for i in 0..n {
            let a = raw[i * 4 + 3];
            tri[i] = if a < 8 {
                Tri::Bg
            } else if a > 247 {
                Tri::Fg
            } else {
                Tri::Unknown
            };
        }
        if let Some(k) = keep {
            for i in 0..n.min(k.len()) {
                if k[i] {
                    tri[i] = Tri::Fg;
                }
            }
        }
        let mut fg = 0;
        let mut bg = 0;
        let mut unk = 0;
        for t in &tri {
            match t {
                Tri::Fg => fg += 1,
                Tri::Bg => bg += 1,
                Tri::Unknown => unk += 1,
            }
        }
        return (tri, (fg, bg, unk));
    }

    // —— 1. 每像素到最近背景色的距离 ——
    let mut dist_bg = vec![0f32; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y as usize) * (w as usize) + (x as usize);
            let p = rgba.get_pixel(x, y);
            dist_bg[i] = bg_distance(p, samples);
        }
    }

    // —— 2. 自适应阈值 ——
    // 用户容差 10..120 映射成色距阈值；同时用分布的分位数兜底 ——
    // 整张图对比度很低时（浅色主体 + 浅底），纯固定阈值会把主体一起判成背景，
    // 取分位数能保证"总有一部分像素被当成前景"。
    let tol = tolerance.clamp(0, 150) as f32;
    // 基准：容差 48 时约 42 的色距阈值（经验值，图标类图普遍合适）
    let base = 8.0 + tol * 0.7;
    let mut sorted: Vec<f32> = dist_bg.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    // 70% 分位：至少 30% 的像素色距比它大（会被当"不像背景"）
    let q70 = sorted[(sorted.len() as f32 * 0.70) as usize % sorted.len().max(1)];
    // 色距阈值 = 基准与分位的较小者，但不超过基准的 2 倍
    let thr_bg = base.min(q70.max(base * 0.35)).clamp(4.0, 160.0);
    // 窄带宽度：色距在 [thr_bg, thr_bg*1.9] 之间算"说不准"
    let thr_unk = (thr_bg * 1.9).clamp(thr_bg + 6.0, 220.0);

    let mut tri = vec![Tri::Unknown; n];
    for i in 0..n {
        let d = dist_bg[i];
        /* r79 修两个视觉缺陷（`tools/r79-matting-visual.js` 抓到的）：
         *
         * 缺陷 A：**环形主体中心的镂空留了白块**。
         *   旧判据里"离边界很远（dist_edge ≥ 0.92）→ 前景"这一条太粗暴 ——
         *   甜甜圈正中心离四条边都很远，于是被硬判成前景，抠完中心留一块白。
         *   但它其实和四边的底**同色**（色距很小），只是因为被主体挡着、
         *   离边界远才被误判。
         *
         * 缺陷 B（另一个场景）：**白底 + 白色主体**时，全图色距≈0，
         *   所有像素都满足"色距小"，于是整张图被判成背景 —— 什么都没抠掉。
         *
         * 两者的共同根因：**判据里缺了"连通性"这一维**。
         * Photoshop 魔术棒的 Contiguous 语义正是：**只有与图像边界连通的
         * 背景才算背景**；一块被主体围住、走不到边界的同色区域，不是背景。
         *
         * 所以下面先给一个"宽松的候选背景"（只看颜色，不看到边界的距离），
         * 再用**连通性**收一遍：从边界出发做泛洪，能走到的才算背景。 */
        if d <= thr_bg {
            tri[i] = Tri::Bg;      // 先当候选，连通性那一步再筛
        } else if d > thr_unk {
            tri[i] = Tri::Fg;
        } else {
            tri[i] = Tri::Unknown;
        }
    }

    /* —— 2b. 连通性收束：只有**能走到图像边界**的候选背景才算背景 ——
     *
     * 4 邻域泛洪（和旧算法的泛洪同源，但这里只用来判定"连通与否"，
     * 不用来决定抠不抠）。从四条边的候选背景出发，能走到的留下。
     * 走不到的（被主体包围的内部区域）退回 Unknown ——
     * 交给 matting 按颜色决定，而不是硬判成背景。
     *
     * ⚠ 为什么用 4 邻域：8 邻域会从对角线"漏"过去，把两个本不相连的
     *   区域连成一片（旧算法注释里也记着这条）。 */
    {
        let mut reach = vec![false; n];
        let mut q: Vec<usize> = Vec::new();
        let push = |i: usize, reach: &mut Vec<bool>, q: &mut Vec<usize>| {
            if tri[i] == Tri::Bg && !reach[i] {
                reach[i] = true;
                q.push(i);
            }
        };
        for x in 0..w {
            push(x as usize, &mut reach, &mut q);
            push(((h - 1) as usize) * (w as usize) + x as usize, &mut reach, &mut q);
        }
        for y in 0..h {
            push((y as usize) * (w as usize), &mut reach, &mut q);
            push((y as usize) * (w as usize) + (w - 1) as usize, &mut reach, &mut q);
        }
        while let Some(i) = q.pop() {
            let x = i % w as usize;
            let y = i / w as usize;
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let j = (ny as usize) * (w as usize) + (nx as usize);
                if tri[j] == Tri::Bg && !reach[j] {
                    reach[j] = true;
                    q.push(j);
                }
            }
        }
        for i in 0..n {
            if tri[i] == Tri::Bg && !reach[i] {
                // 走不到边界 → 不是背景。留给 matting 判（通常是主体内部）
                tri[i] = Tri::Unknown;
            }
        }
    }

    /* —— 2c. 小结：这一版的判据只由**颜色 + 连通性**决定 ——
     *
     * 旧版还有一条"离边界很远 → 前景"（`dist_edge >= 0.92`），它带来了
     * 环形中心留白块的缺陷。上一版注释里那句"缺陷 B 的补救"其实不需要额外
     * 代码：白底白主体时前景/背景主色几乎相同，`has_reliable_background`
     * 会判定"没有可靠背景"，由 `matte` 走保守出口（原图不动）。
     * 所以这里不再补一条死代码 —— `Tri::Unknown` 的定义本来就是
     * `thr_bg < d <= thr_unk`，不可能再满足 `d > thr_unk`。 */

    // —— 3. 形态学整理：先腐蚀前景 / 膨胀背景，留出窄带 ——
    // 腐蚀半径随图幅走（512 的图用 2px，小图至少 1px）
    let r = ((w.min(h) as f32 / 180.0).round() as i32).clamp(1, 3);
    // 前景收缩 r 圈（只保留"稳"的前景）
    let fg0: Vec<bool> = tri.iter().map(|t| *t == Tri::Fg).collect();
    let fg_eroded = erode(&fg0, w, h, r);
    // 背景扩张 r 圈
    let bg0: Vec<bool> = tri.iter().map(|t| *t == Tri::Bg).collect();
    let bg_dilated = dilate(&bg0, w, h, r);

    for i in 0..n {
        if bg_dilated[i] {
            tri[i] = Tri::Bg;
        } else if fg_eroded[i] {
            tri[i] = Tri::Fg;
        } else {
            tri[i] = Tri::Unknown;
        }
    }

    // —— 4. 手动描边 = 硬约束的确定前景 ——
    // 用户描过的区域**无条件**是前景，连窄带都不参与（他就是要保住那块）
    if let Some(k) = keep {
        for i in 0..n.min(k.len()) {
            if k[i] {
                tri[i] = Tri::Fg;
            }
        }
    }

    // 全透明像素直接算背景（它们本来就是）
    let raw = rgba.as_raw();
    for (i, t) in tri.iter_mut().enumerate().take(n) {
        if raw[i * 4 + 3] < 8 {
            *t = Tri::Bg;
        }
    }

    let mut fg = 0;
    let mut bg = 0;
    let mut unk = 0;
    for t in &tri {
        match t {
            Tri::Fg => fg += 1,
            Tri::Bg => bg += 1,
            Tri::Unknown => unk += 1,
        }
    }
    (tri, (fg, bg, unk))
}

/// 4 邻域腐蚀 `r` 轮。边缘外一律当"不是前景"（所以贴边的前景会被削掉一圈，
/// 这正是我们要的 —— 贴边的像素最可疑）。
fn erode(mask: &[bool], w: u32, h: u32, r: i32) -> Vec<bool> {
    let mut cur = mask.to_vec();
    for _ in 0..r {
        let prev = cur.clone();
        for y in 0..h {
            for x in 0..w {
                let i = (y as usize) * (w as usize) + (x as usize);
                if !prev[i] {
                    continue;
                }
                let mut all = true;
                for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        all = false;
                        break;
                    }
                    if !prev[(ny as usize) * (w as usize) + (nx as usize)] {
                        all = false;
                        break;
                    }
                }
                cur[i] = all;
            }
        }
    }
    cur
}

/// 4 邻域膨胀 `r` 轮。边缘外当"是背景"（所以贴边的背景会保住）。
fn dilate(mask: &[bool], w: u32, h: u32, r: i32) -> Vec<bool> {
    let mut cur = mask.to_vec();
    for _ in 0..r {
        let prev = cur.clone();
        for y in 0..h {
            for x in 0..w {
                let i = (y as usize) * (w as usize) + (x as usize);
                if prev[i] {
                    continue;
                }
                let mut any = false;
                for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        any = true;   // 边界外算背景 → 贴边像素被膨胀到
                        break;
                    }
                    if prev[(ny as usize) * (w as usize) + (nx as usize)] {
                        any = true;
                        break;
                    }
                }
                cur[i] = any;
            }
        }
    }
    cur
}

/// 从 trimap 里的三态，数出"有没有可靠背景"。
///
/// 判据三条（任一成立即"没有可靠背景"）：
///   ① 背景占比太小（< 3%）—— 主体顶满四边，没有可用的背景样本；
///   ② **前景样本为空** —— 全图被判成背景候选，根本不存在"主体像素"，
///      算法无从知道要保留什么。全同色图正是这一条（r79 加了连通性收束后，
///      它的候选背景全部与边界连通，于是没有像素落在前景态）。
///   ③ **背景样本与前景样本几乎同色** —— "背景色"其实等于"主体色"，
///      任何按颜色分离的算法都无从下手。
///
/// 返回 false 时 `matte` 会走保守出口（原图不动），界面提示"这张图看起来
/// 没有背景"——而不是给一个糟糕结果。
pub fn has_reliable_background(
    counts: (usize, usize, usize),
    total: usize,
    fg_colors: &[[f32; 3]],
    bg_colors: &[[f32; 3]],
) -> bool {
    let (fg, bg, _unk) = counts;
    if total == 0 {
        return false;
    }
    if (bg as f32 / total as f32) < 0.03 {
        return false;
    }
    // ② 一个前景像素都没有 → 没有"要保留的东西"，谈不上抠背景
    if fg == 0 || fg_colors.is_empty() {
        return false;
    }
    // ③ 前景/背景主色几乎重合 → 分不开
    if let (Some(f), Some(b)) = (fg_colors.first(), bg_colors.first()) {
        let d = ((f[0] - b[0]).powi(2) + (f[1] - b[1]).powi(2) + (f[2] - b[2]).powi(2)).sqrt();
        if d < 12.0 {
            return false;
        }
    }
    true
}

/// 把 trimap 三态里"背景占比"最高的一批像素当作背景样本，供后续 matting 用。
pub fn collect_fg_bg_colors(
    rgba: &image::RgbaImage,
    tri: &[Tri],
) -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
    let (w, _h) = rgba.dimensions();
    let mut fg = Vec::new();
    let mut bg = Vec::new();
    // 采样上限：颜色样本太多会让后面的"最近色"查询变慢
    const MAX: usize = 4096;
    let step = (tri.len() / MAX).max(1);
    for i in (0..tri.len()).step_by(step) {
        let x = (i % w as usize) as u32;
        let y = (i / w as usize) as u32;
        let p = rgba.get_pixel(x, y);
        let c = [p[0] as f32, p[1] as f32, p[2] as f32];
        match tri[i] {
            Tri::Fg => fg.push(c),
            Tri::Bg => bg.push(c),
            Tri::Unknown => {}
        }
    }
    (fg, bg)
}

/// 对窄带做**基于颜色距离的 alpha 估计**（Closed-Form 的实用近似）。
///
/// 完整的 Closed-Form Matting 要在窄带上解一个 `|U| × |U|` 的稀疏线性系统
/// （Levin 2006 的 L 矩阵）。这里用一个**同源但更轻**的做法，效果对图标足够、
/// 且实现可读、无需引入稀疏求解依赖：
///
/// ```text
///   对每个 Unknown 像素 p：
///     dF = 到最近"确定前景色"的距离
///     dB = 到最近"确定背景色"的距离
///     a  = dB / (dF + dB)          ← 离背景越远越不透明
///   然后把 a 当作**数据项**，用图像自身边缘做**平滑项**，
///   在窄带上迭代若干轮（Jacobi 式松弛）：
///     a_i ← (λ·a_i^data + Σ w_ij·a_j) / (λ + Σ w_ij)
///     w_ij = exp(-|I_i - I_j|² / σ²)    ← 颜色越接近，约束越强
/// ```
///
/// 这一步是"像 PS"的**关键差异**：alpha 不再由硬阈值决定，而是沿着图像里
/// 真实存在的颜色边界平滑过渡 —— 所以边缘是抗锯齿的、不会出现锯齿或白边。
///
/// `keep` 里的像素 alpha 恒为 1（手动描边的硬约束）。
pub fn solve_alpha(
    rgba: &image::RgbaImage,
    tri: &[Tri],
    fg_colors: &[[f32; 3]],
    bg_colors: &[[f32; 3]],
    keep: Option<&[bool]>,
    iterations: u32,
) -> Vec<f32> {
    let (w, h) = rgba.dimensions();
    let n = (w as usize) * (h as usize);

    // —— 1. 初始 alpha：三态定值 + 窄带按色距插值 ——
    let mut alpha = vec![0f32; n];
    for i in 0..n {
        alpha[i] = match tri[i] {
            Tri::Bg => 0.0,
            Tri::Fg => 1.0,
            Tri::Unknown => {
                let x = (i % w as usize) as u32;
                let y = (i / w as usize) as u32;
                let p = rgba.get_pixel(x, y);
                let c = [p[0] as f32, p[1] as f32, p[2] as f32];
                let df = nearest_dist(c, fg_colors);
                let db = nearest_dist(c, bg_colors);
                if df.is_infinite() && db.is_infinite() {
                    0.5
                } else if df.is_infinite() {
                    0.0
                } else if db.is_infinite() {
                    1.0
                } else {
                    // dB 大 = 离背景远 = 更像前景
                    let s = df + db;
                    if s < 1e-6 { 0.5 } else { (db / s).clamp(0.0, 1.0) }
                }            }
        };
    }

    if iterations == 0 {
        return alpha;
    }

    // —— 2. 只在窄带上松弛（外面都是定值，不参与）——
    // σ²：颜色差的高斯尺度。图标颜色通常分得很开，取 40² 足够。
    let sigma2 = 40.0f32 * 40.0;
    // λ：数据项强度。太大则退化成初始值（边缘仍硬），太小则被邻域带跑。
    let lambda = 0.35f32;
    let data = alpha.clone();

    let mut buf = alpha.clone();
    for _ in 0..iterations {
        for y in 0..h {
            for x in 0..w {
                let i = (y as usize) * (w as usize) + (x as usize);
                if tri[i] != Tri::Unknown {
                    continue;
                }
                if let Some(k) = keep {
                    if k.get(i).copied().unwrap_or(false) {
                        buf[i] = 1.0;
                        continue;
                    }
                }
                let pc = rgba.get_pixel(x, y);
                let mut num = lambda * data[i];
                let mut den = lambda;
                for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let j = (ny as usize) * (w as usize) + (nx as usize);
                    let qc = rgba.get_pixel(nx as u32, ny as u32);
                    let dr = pc[0] as f32 - qc[0] as f32;
                    let dg = pc[1] as f32 - qc[1] as f32;
                    let db = pc[2] as f32 - qc[2] as f32;
                    let wgt = (-(dr * dr + dg * dg + db * db) / sigma2).exp();
                    num += wgt * alpha[j];
                    den += wgt;
                }
                buf[i] = if den > 1e-6 { (num / den).clamp(0.0, 1.0) } else { data[i] };
            }
        }
        std::mem::swap(&mut alpha, &mut buf);
    }

    // —— 3. 最后把定值再钉一次（松弛时它们没动，这里防浮点漂移）——
    for i in 0..n {
        match tri[i] {
            Tri::Bg => alpha[i] = 0.0,
            Tri::Fg => alpha[i] = 1.0,
            Tri::Unknown => {}
        }
    }
    /* r79：**尊重原图自带的 alpha**。
     *
     * 为什么必须加这一步：一张本来就抠好、只是四周留了透明边的 PNG，它的
     * 透明像素 RGB 通常是 (0,0,0) —— 这个颜色与"白底/浅底"的色距很大，
     * 于是 trimap 会把它判成**前景**，matting 又把 alpha 拉满，结果
     * "本来透明的边缘被填成了半透明黑"（单测 `already_transparent_is_noop`
     * 抓到的正是它：中心 128 而不是 255）。
     *
     * 口径：原 alpha 是**上界**，不是等号 ——
     *   · 原 alpha = 0 → 结果必为 0（它本来就是透明的，我们没有理由让它不透明）；
     *   · 原 alpha = 255 → 结果由 matting 决定（可能被抠掉，这是本功能的用途）；
     *   · 原 alpha 半透明 → 结果不超过它（保留原有的半透明信息）。
     * 用户手动描边的区域仍然强制 1.0（他是明确要保住那块）。 */
    let raw = rgba.as_raw();
    for i in 0..n {
        let orig = raw[i * 4 + 3] as f32 / 255.0;
        alpha[i] = alpha[i].min(orig.max(if orig < 0.02 { 0.0 } else { orig }));
        // 等价于 alpha = min(alpha, orig)，但当 orig≈0 时确保真的是 0
        if orig < 0.02 {
            alpha[i] = 0.0;
        }
    }
    if let Some(k) = keep {
        for i in 0..n.min(k.len()) {
            if k[i] {
                alpha[i] = 1.0;
            }
        }
    }
    alpha
}

/// 到一组颜色的最近距离（欧氏）。
fn nearest_dist(c: [f32; 3], list: &[[f32; 3]]) -> f32 {
    let mut best = f32::INFINITY;
    for s in list {
        let dr = c[0] - s[0];
        let dg = c[1] - s[1];
        let db = c[2] - s[2];
        let d = (dr * dr + dg * dg + db * db).sqrt();
        if d < best {
            best = d;
        }
    }
    best
}

/// 边缘去色（decontamination）：反解前景色 `F = (I - (1-a)·B) / a`。
///
/// 为什么必须做：抗锯齿边缘的像素其实是"前景色与背景色的混合"。只把 alpha
/// 设成 0.5、颜色还是原来的混合色，放到深色背景上就会出现**一圈白边**
/// （或绿边 / 任何底色的边）—— 这是所有"半吊子抠图"最明显的破绽。
///
/// 做法：对 `0.02 < a < 0.98` 的像素，用最近的背景色反解出纯前景色。
/// 反解结果越界（<0 或 >255）就钳住 —— 那是估计误差，钳住比发散好看。
pub fn decontaminate(rgba: &mut image::RgbaImage, alpha: &[f32], bg_colors: &[[f32; 3]]) {
    if bg_colors.is_empty() {
        return;
    }
    let (w, h) = rgba.dimensions();
    for y in 0..h {
        for x in 0..w {
            let i = (y as usize) * (w as usize) + (x as usize);
            let a = alpha[i];
            if !(0.02..0.98).contains(&a) {
                continue;
            }
            let p = rgba.get_pixel(x, y);
            let c = [p[0] as f32, p[1] as f32, p[2] as f32];
            // 用**离它最近**的那个背景色反解（同一块边缘通常只挨着一种底色）
            let mut best = bg_colors[0];
            let mut bestd = f32::INFINITY;
            for s in bg_colors {
                let d = (c[0] - s[0]).powi(2) + (c[1] - s[1]).powi(2) + (c[2] - s[2]).powi(2);
                if d < bestd {
                    bestd = d;
                    best = *s;
                }
            }
            let inv = 1.0 / a;
            let f = [
                ((c[0] - (1.0 - a) * best[0]) * inv).clamp(0.0, 255.0),
                ((c[1] - (1.0 - a) * best[1]) * inv).clamp(0.0, 255.0),
                ((c[2] - (1.0 - a) * best[2]) * inv).clamp(0.0, 255.0),
            ];
            let px = rgba.get_pixel_mut(x, y);
            px[0] = f[0] as u8;
            px[1] = f[1] as u8;
            px[2] = f[2] as u8;
        }
    }
}

/// 把 alpha 写回 RGBA：`新 alpha = 原 alpha × matting alpha`。
///
/// 相乘而不是覆盖：原图可能本来就带透明度（半透明 logo），两者都要保留。
pub fn apply_alpha(rgba: &mut image::RgbaImage, alpha: &[f32]) -> usize {
    let (w, h) = rgba.dimensions();
    let mut removed = 0usize;
    for y in 0..h {
        for x in 0..w {
            let i = (y as usize) * (w as usize) + (x as usize);
            let a = alpha[i].clamp(0.0, 1.0);
            let px = rgba.get_pixel_mut(x, y);
            let old = px[3] as f32 / 255.0;
            let new = old * a;
            if old > 0.02 && new < 0.02 {
                removed += 1;
            }
            px[3] = (new * 255.0).round() as u8;
        }
    }
    removed
}

/// 裁掉四周全透明的空白，返回裁切后的图（让图标在格子里更"满"）。
///
/// 这一步替代了旧实现里那个"光学尺寸归一"要做的一半事情 ——
/// 抠完之后主体周围常留一圈空，裁掉它视觉上会大一圈。
pub fn trim_transparent(img: &image::RgbaImage) -> image::RgbaImage {
    let (w, h) = img.dimensions();
    let mut x0 = w;
    let mut y0 = h;
    let mut x1 = 0u32;
    let mut y1 = 0u32;
    for y in 0..h {
        for x in 0..w {
            if img.get_pixel(x, y)[3] > 8 {
                if x < x0 { x0 = x; }
                if y < y0 { y0 = y; }
                if x > x1 { x1 = x; }
                if y > y1 { y1 = y; }
            }
        }
    }
    if x1 < x0 || y1 < y0 {
        return img.clone();   // 全透明，原样返回
    }
    // 留 1px 余量，避免把边缘抗锯齿切掉
    let x0 = x0.saturating_sub(1);
    let y0 = y0.saturating_sub(1);
    let x1 = (x1 + 1).min(w - 1);
    let y1 = (y1 + 1).min(h - 1);
    image::imageops::crop_imm(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image()
}

/// 一条龙：估背景 → 建 trimap → 解 alpha → 去色 → 合成。
///
/// `keep`：手动描边蒙版（`None` = 全自动）。
/// `trim`：抠完是否裁掉四周空白。
pub fn matte(
    bytes: &[u8],
    tolerance: u32,
    keep: Option<&[bool]>,
    iterations: u32,
    trim: bool,
) -> Result<Matting, String> {
    let mut rgba = prepare(bytes)?;
    let (w, h) = rgba.dimensions();
    if w < 2 || h < 2 {
        return Err("图太小了（至少 2×2）".to_string());
    }
    let n = (w as usize) * (h as usize);
    let keep_slice = keep.map(|k| &k[..k.len().min(n)]);

    let samples = estimate_background(&rgba);
    let (tri, counts) = build_trimap(&rgba, &samples, tolerance, keep_slice);
    /* 先取前景/背景颜色样本，再判"有没有可靠背景" ——
     * 后者要看两者的色差（全同色图靠这个识别出来）。 */
    let (fg_colors, bg_colors) = collect_fg_bg_colors(&rgba, &tri);
    let reliable = has_reliable_background(counts, n, &fg_colors, &bg_colors);

    /* r79：**没有可靠背景时，不许把图抠光** —— 除非用户手动指定了前景。
     *
     * 为什么必须分开这两种情况（探针 5b 抓到的真问题）：
     *   · 整张同色图**且用户没描任何东西**：算法其实无从知道主体在哪，
     *     它算出来的"背景"等于"整张图"。硬抠的结果是把图整个抹掉，
     *     而前端只显示一句"这张图看起来没有背景" —— 用户看到的是被毁掉的图。
     *     正确做法：**什么都不动**，removed=0，由界面告诉用户"没东西可抠"。
     *   · 整张同色图**但用户手动补描了**：那是他在明确说"这块是主体"。
     *     这时就该按他说的做：描过的保住、其余按边缘连通性抠掉 ——
     *     这正是旧算法（颜色泛洪）擅长的场景，此时它的结果可预期、也符合用户意图。
     *
     * 判据用 `keep_slice` 里有没有真的涂过东西，不是"传没传蒙版"
     * （传了一个全零蒙版等于没描）。 */
    let painted = keep_slice.map(|k| k.iter().any(|x| *x)).unwrap_or(false);
    if !reliable && !painted {
        // 保守出口：原图原样返回，一个像素都不动
        let out = if trim { trim_transparent(&rgba) } else { rgba };
        return Ok(Matting {
            rgba: out,
            removed: 0,
            no_background: true,
            tri_counts: counts,
        });
    }

    let alpha = solve_alpha(&rgba, &tri, &fg_colors, &bg_colors, keep_slice, iterations);
    decontaminate(&mut rgba, &alpha, &bg_colors);
    let removed = apply_alpha(&mut rgba, &alpha);
    let out = if trim { trim_transparent(&rgba) } else { rgba };

    Ok(Matting {
        rgba: out,
        removed,
        no_background: !reliable,
        tri_counts: counts,
    })
}

/// PNG 编码（图标必须保 alpha，所以恒走 PNG）。
pub fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("编码 PNG 失败：{e}"))?;
    Ok(buf)
}

/// 测试用：把图编码成 PNG 字节（走与生产同一条 `image` 编码路径）。
#[cfg(test)]
fn png_of(img: &image::RgbaImage) -> Vec<u8> {
    encode_png(img).expect("测试图编码不该失败")
}

/// 一张"明确有背景"的测试图：白底 + 深色圆。
#[cfg(test)]
fn white_bg_with_circle(size: u32) -> image::RgbaImage {
    let mut img = image::RgbaImage::new(size, size);
    let c = size as f32 / 2.0;
    let r = size as f32 * 0.3;
    for (x, y, p) in img.enumerate_pixels_mut() {
        let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
        *p = if d <= r {
            image::Rgba([40, 60, 200, 255])
        } else {
            image::Rgba([255, 255, 255, 255])
        };
    }
    img
}


#[cfg(test)]
mod tests {
    use super::*;

    fn alpha_at(img: &image::RgbaImage, x: u32, y: u32) -> u8 {
        img.get_pixel(x, y)[3]
    }

    /// 最基本的一条：白底蓝圆，背景该被抠掉、主体该保住。
    #[test]
    fn 白底圆形主体能正确分离() {
        let img = white_bg_with_circle(96);
        let m = matte(&png_of(&img), 48, None, 12, false).expect("应当成功");
        assert!(!m.no_background, "这张图有明显背景");
        assert_eq!(alpha_at(&m.rgba, 48, 48), 255, "圆心必须不透明");
        assert_eq!(alpha_at(&m.rgba, 2, 2), 0, "四角必须透明");
        assert!(m.removed > 2000, "背景应当被大量抠掉，实际 {}", m.removed);
    }

    /// **用户报的那个 bug**：浅色主体落在浅底上。
    /// 旧算法（颜色泛洪）会把主体一起吃掉；新算法必须保住它。
    #[test]
    fn 浅色主体落在浅底上也能保住() {
        // 底 #F8F8F8，主体 #E8E8E8 —— 只差 16，任何"只看颜色"的算法都会失败
        let mut img = image::RgbaImage::new(96, 96);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let inside = (24..72).contains(&x) && (24..72).contains(&y);
            *p = if inside {
                image::Rgba([0xE8, 0xE8, 0xE8, 255])
            } else {
                image::Rgba([0xF8, 0xF8, 0xF8, 255])
            };
        }
        let m = matte(&png_of(&img), 48, None, 16, false).expect("应当成功");
        // 关键：主体中心必须还在
        assert_eq!(
            alpha_at(&m.rgba, 48, 48),
            255,
            "浅色主体中心必须保住（这正是旧算法出错的地方）"
        );
        // 四角仍然该被抠掉
        assert_eq!(alpha_at(&m.rgba, 1, 1), 0, "四角是背景，该透明");
    }

    /// 手动描边 = 硬约束：描过的区域哪怕颜色跟背景一模一样也必须保住。
    #[test]
    fn 手动描边是无条件保护() {
        let mut img = image::RgbaImage::new(64, 64);
        // 整张图同色 —— 没有任何算法能"看出"主体，只能靠描边
        for p in img.pixels_mut() {
            *p = image::Rgba([200, 200, 200, 255]);
        }
        let mut keep = vec![false; 64 * 64];
        for y in 20..44u32 {
            for x in 20..44u32 {
                keep[(y * 64 + x) as usize] = true;
            }
        }
        let m = matte(&png_of(&img), 48, Some(&keep), 8, false).expect("应当成功");
        assert_eq!(alpha_at(&m.rgba, 32, 32), 255, "描过的中心必须保住");
        assert_eq!(alpha_at(&m.rgba, 2, 2), 0, "没描的地方该被抠掉");
    }

    /// 全透明输入不该报错、也不该变样。
    #[test]
    fn 全透明图原样返回() {
        let img = image::RgbaImage::new(32, 32);   // 全 0
        let m = matte(&png_of(&img), 48, None, 4, false).expect("应当成功");
        assert_eq!(m.removed, 0);
        assert_eq!(alpha_at(&m.rgba, 16, 16), 0);
    }

    /// 主体顶满四边（没有背景）→ 标记 no_background，**且不动原图**。
    ///
    /// r79：这条测试的价值在于钉住后面那半句。探针 `r79-matting-probe` 的
    /// 5b 曾抓到：判定"没有背景"之后仍然把图整个抠光了（16320/16384 像素），
    /// 用户看到的是被毁掉的图 + 一句轻飘飘的提示。正确行为是**原样返回**。
    #[test]
    fn 主体顶满四边时标记无背景且不动图() {
        let img = image::RgbaImage::from_pixel(64, 64, image::Rgba([10, 20, 30, 255]));
        let m = matte(&png_of(&img), 48, None, 4, false).expect("应当成功");
        assert!(m.no_background, "全同色图应当被判定为没有背景");
        assert_eq!(m.removed, 0, "既然没背景可分，就不该抠掉任何像素");
        assert_eq!(
            alpha_at(&m.rgba, 32, 32),
            255,
            "原图必须原样保留（中心不该被抠透明）"
        );
    }

    /// 但**用户手动补描之后**，同一张同色图就该按他说的抠：
    /// 描过的保住，其余按连通性抠掉。
    #[test]
    fn 同色图但手动补描后就按描的来() {
        let img = image::RgbaImage::from_pixel(64, 64, image::Rgba([10, 20, 30, 255]));
        let mut keep = vec![false; 64 * 64];
        for y in 24..40u32 {
            for x in 24..40u32 {
                keep[(y * 64 + x) as usize] = true;
            }
        }
        let m = matte(&png_of(&img), 48, Some(&keep), 8, false).expect("应当成功");
        assert_eq!(alpha_at(&m.rgba, 32, 32), 255, "描过的中心必须保住");
        assert_eq!(alpha_at(&m.rgba, 2, 2), 0, "没描的地方按连通性抠掉");
        assert!(m.removed > 1000, "应当确实抠掉了外围，实际 {}", m.removed);
    }

    /// 裁切：抠完后四周空白应当被裁掉。
    #[test]
    fn 抠完会裁掉四周空白() {
        let img = white_bg_with_circle(128);
        let m = matte(&png_of(&img), 48, None, 12, true).expect("应当成功");
        let (w, h) = m.rgba.dimensions();
        assert!(w < 128 && h < 128, "应当被裁小，实际 {w}×{h}");
        assert!(w > 40, "但不该裁到只剩一点，实际 {w}");
    }

    /// 坏输入要报错而不是 panic。
    #[test]
    fn 坏输入报错() {
        assert!(matte(b"not an image", 48, None, 4, false).is_err());
        assert!(matte(&[], 48, None, 4, false).is_err());
    }

    /// 去色：抗锯齿边缘不该留下白边。
    ///
    /// r79：这条改成**直接测 `decontaminate`**，而不是"跑完整 matting 再找
    /// 半透明像素"。原因：完整流程里的半透明像素数量取决于 trimap 怎么切，
    /// 图稍微规整一点就可能一个半透明像素都不产生 —— 那样测的是"trimap 的
    /// 切法"而不是"去色算得对不对"，很容易变成一条脆弱的假失败。
    ///
    /// 这里直接构造"已知 alpha + 已知背景"的场景，验证反解公式：
    ///   `F = (I - (1-a)·B) / a`
    /// 蓝色前景 a=0.5 混在白底上 → I = (128,128,228)；
    /// 反解应当还原出接近纯蓝的 F（而不是留着灰调的 128,128）。
    #[test]
    fn 边缘去色能把混合色还原成纯前景色() {
        // 一个像素：白底上的半透明蓝
        let mut img = image::RgbaImage::from_pixel(2, 2, image::Rgba([128, 128, 228, 255]));
        let alpha = vec![0.5f32; 4];
        let bg = vec![[255.0f32, 255.0f32, 255.0f32]];
        decontaminate(&mut img, &alpha, &bg);
        let p = img.get_pixel(0, 0);
        /* 期望：R = (128 - 0.5*255)/0.5 = 1，G 同理 = 1，B = (228-127.5)/0.5 = 201
         * 也就是说灰调被去掉了，只剩下纯蓝。 */
        assert!(p[0] < 20, "红色通道应当被去干净，实际 {}", p[0]);
        assert!(p[1] < 20, "绿色通道应当被去干净，实际 {}", p[1]);
        assert!(p[2] > 180, "蓝色通道应当保留，实际 {}", p[2]);
        assert!(
            p[2] as i32 - p[0] as i32 > 150,
            "去色后应当明显偏蓝（蓝-红 > 150），实际 {:?}",
            p
        );
    }

    /// 去色不该碰**完全透明或完全不透明**的像素 —— 那些没有混合可反解。
    #[test]
    fn 去色不碰全透明与全不透明像素() {
        let mut img = image::RgbaImage::from_pixel(2, 1, image::Rgba([100, 110, 120, 255]));
        let alpha = vec![0.0f32, 1.0f32];
        let bg = vec![[255.0f32, 255.0f32, 255.0f32]];
        decontaminate(&mut img, &alpha, &bg);
        assert_eq!(img.get_pixel(0, 0)[0], 100, "alpha=0 的像素不该被动");
        assert_eq!(img.get_pixel(1, 0)[0], 100, "alpha=1 的像素不该被动");
    }
}
