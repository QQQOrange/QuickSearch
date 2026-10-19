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

    /* —— 3. 形态学整理：**两侧都腐蚀**，夹出未知带 ——
     *
     * ⚠ r79 关键修正。早先这里"前景腐蚀 + 背景**膨胀**"，实测把抗锯齿边缘
     * 整个吞成了背景。扫描线证据（`dbg_scanline`，Excalidraw 图 y=42% 那行）：
     * ```text
     *   B:42(255,255,255)  B:43(190,187,238)  F:44(106,102,219)
     *   trimap=(8703, 22993, 704)   ← 未知只有 704 像素（2.2%）
     * ```
     * x=43 的 (190,187,238) 明显是白底与紫色主体的**混合色**（抗锯齿像素），
     * 它本该落在未知带里交给解混去算 α —— 结果被判成背景直接抠掉，
     * 于是主体边缘少了一圈，看起来就是"锯齿 + 白边"。
     *
     * 原因：背景**膨胀**会把边界外侧的未知带吃掉（膨胀 = 背景向外长）。
     *
     * 正确做法是**两侧都腐蚀**：确定的背景向内收 r 圈、确定的前景向内收 r 圈，
     * 中间夹出来的一条才是未知带。这样边缘两侧都有过渡区，
     * 抗锯齿像素不会被任何一侧吞掉。
     *
     * r 取 2~3：真实抗锯齿边缘只有 1~2px，两侧各留 r 圈足够覆盖；
     * 再宽会把主体内部也算进未知区（既慢又可能把主体抠花）。
     * 注意：贴图像边框的那一圈会因背景腐蚀而变成未知，这是**有意的** ——
     * 它们在解混时 I≈B，α 自然算成 0，不会误留。 */
    let r = ((w.min(h) as f32 / 90.0).round() as i32).clamp(2, 3);
    let fg0: Vec<bool> = tri.iter().map(|t| *t == Tri::Fg).collect();
    let bg0: Vec<bool> = tri.iter().map(|t| *t == Tri::Bg).collect();
    let fg_eroded = erode(&fg0, w, h, r);
    let bg_eroded = erode(&bg0, w, h, r);

    for i in 0..n {
        if fg_eroded[i] {
            // 收缩后仍是前景 → 确定前景（主体内部的稳像素）
            tri[i] = Tri::Fg;
        } else if bg_eroded[i] {
            // 收缩后仍是背景 → 确定背景（离主体足够远的底色）
            tri[i] = Tri::Bg;
        } else {
            // 其余都是"说不准"：主体边缘的抗锯齿带 + 主体内部
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

/// **颜色解混（color unmixing）估 alpha** —— 图标这类"平涂图形 + 抗锯齿边缘"
/// 的正确模型。
///
/// # 为什么最终没用 Closed-Form Matting（一次诚实的判断）
///
/// 我照 pymatting 的 `cf_laplacian` + `estimate_alpha_cf` 实现过完整的 CF matting
/// （matting Laplacian + 共轭梯度，含 Jacobi 预处理与 CSR 组装）。实测在
/// **真实图标**上不合格（`tools/r79-real-icons.js` + 内置诊断）：
///
/// | 真实图标 | 未知像素占比 | 求解耗时 |
/// |---|---|---|
/// | IGN.png（细条纹） | 11.5% | 394ms |
/// | GOG.png | 13.8% | 236ms |
/// | 139_邮箱.png | 17.4% | 132ms |
///
/// 而且**迭代次数从 12 加到 300，抠掉像素数几乎不变**（27023 → 27013）——
/// 说明 CF 在这类图上几乎没起作用，边缘仍由 trimap 硬阈值决定。
///
/// 原因不是实现错了，是**场景不对**：CF 的"局部颜色线"假设是为**自然图像**设计的
/// （毛发、羽毛、烟雾那些"一个窗口里颜色能拟合出一条线"的区域）。图标是平涂色块，
/// 边缘只有 1~2px 抗锯齿，CF 没有发挥空间，却要为它付出建矩阵的代价。
/// 换用解混后同样的图降到 **17~39ms**（10 倍），质量反而更好。
///
/// # 用对的模型：合成方程逐像素反解
///
/// 抗锯齿边缘的像素本来就是前景色与背景色的**线性混合**：
/// ```text
///     I = α·F + (1-α)·B
/// ```
/// 已知观测色 I，只要能给出 B（该像素处的背景色）与 F（前景色），
/// α 就有闭式解 —— 把 `I-B` 投影到 `F-B` 方向：
/// ```text
///     α = ((I-B)·(F-B)) / |F-B|²
/// ```
/// 这是**精确模型**（不是近似），所以边缘天然平滑。
///
/// # 三个量怎么来
///
/// 1. **B（背景色，逐像素）**：对"确定背景"像素做**二次曲面最小二乘拟合**
///    （见 `fit_background`）。纯色底是零阶特例、线性渐变被精确命中。
/// 2. **F（前景色，逐像素）**：只取"确定前景"（已腐蚀，是主体内部纯净色）
///    的局部均值（见 `local_foreground`）。**不能把边缘混合像素算进样本** ——
///    那会让 F 偏白，去色后留白边。
/// 3. **α**：按上面的闭式解，钳到 [0,1]。
///
/// # 边缘去色
///
/// 混合像素（`0 < α < 1`）的 RGB **直接置为估算前景色 F**，不反解。
/// 为什么：反解式 `F = (I-(1-α)B)/α` 在 α 小时数值上不可靠（除以很小的数
/// 放大舍入误差），实测在深色底上留下**一圈白边**。
/// 而"直接用 F"没有这个问题 —— 反正 α 已经表达了"有多少是前景"，
/// 颜色就该是前景色本身。这是商业抠图的常规做法。
///
/// # 信息论上的死角
///
/// `|F-B|` 很小时（前景与背景同色，比如白 logo 落在白底上）α 无从反解 ——
/// 这不是算法缺陷，是**方程本身欠定**。这类图任何纯像素算法都无解，
/// 只能靠用户**手动补描**给出前景约束，或用手动描边蒙版。
/// 代码对这种像素取保守值，`matte` 层通过 `no_background` 告诉界面。
pub fn solve_alpha(
    rgba: &mut image::RgbaImage,
    tri: &[Tri],
    keep: Option<&[bool]>,
) -> Vec<f32> {
    let (w, h) = rgba.dimensions();
    let n = (w as usize) * (h as usize);

    // 手动补描 = 无条件的前景（硬约束），它同时影响 B 的拟合与 F 的取样
    let forced = |i: usize| -> bool {
        keep.map(|k| k.get(i).copied().unwrap_or(false)).unwrap_or(false)
    };

    // ---- 1. 逐像素背景色：二次曲面最小二乘 ----
    let b_map = fit_background(rgba, tri, keep);

    // ---- 2. 逐像素前景色：确定前景的局部均值（只算未知像素） ----
    let f_map = local_foreground(rgba, tri, keep);

    /* 先算"这个未知像素是不是被前景包围"——
     * 用于区分**主体内部的浅色细节**与**真正的边缘**。
     * 判据：在 5×5 窗口里，确定前景像素的占比 ≥ 50%。 */
    let interior = |i: usize| -> bool {
        let x = (i % w as usize) as i32;
        let y = (i / w as usize) as i32;
        let mut fg_n = 0;
        let mut tot = 0;
        for dy in -2i32..=2 {
            let yy = y + dy;
            if yy < 0 || yy >= h as i32 {
                continue;
            }
            for dx in -2i32..=2 {
                let xx = x + dx;
                if xx < 0 || xx >= w as i32 {
                    continue;
                }
                let j = (yy as usize) * (w as usize) + xx as usize;
                if tri[j] == Tri::Fg || forced(j) {
                    fg_n += 1;
                }
                tot += 1;
            }
        }
        tot > 0 && fg_n * 2 >= tot
    };

    // ---- 3. α：颜色解混 ----
    let mut alpha = vec![0f32; n];
    for i in 0..n {
        if forced(i) {
            alpha[i] = 1.0;
            continue;
        }
        match tri[i] {
            Tri::Bg => {
                alpha[i] = 0.0;
                continue;
            }
            Tri::Fg => {
                alpha[i] = 1.0;
                continue;
            }
            Tri::Unknown => {}
        }
        /* r79：**被前景包围的未知像素 = 主体自己的内部细节，直接算前景。**
         *
         * 为什么需要这条（实测抓到的第二个问题）：Excalidraw 图标主体内部
         * 本来画了一条**浅紫描边**（设计的一部分，如 (166,163,234)）。
         * 它比主体紫色浅、离白底又不算太远，于是色距落在未知带里；
         * 一旦按"与背景色解混"去算，就会得到一个低 α 而被抠掉 ——
         * 主体内部被啃出缺口。
         *
         * 判据是几何的，不是颜色的：如果这个像素周围一圈**基本都是确定前景**，
         * 那它显然在主体内部，背景色根本照不进来，α 必然是 1。
         * 用几何判据而不是颜色判据，是因为颜色在内部浅色细节上不可靠。 */
        if interior(i) {
            alpha[i] = 1.0;
            continue;
        }
        let x = (i % w as usize) as u32;
        let y = (i / w as usize) as u32;
        let p = rgba.get_pixel(x, y);
        let ic = [
            p[0] as f32 / 255.0,
            p[1] as f32 / 255.0,
            p[2] as f32 / 255.0,
        ];
        let b = b_map[i];
        let f = f_map[i];
        let d = [f[0] - b[0], f[1] - b[1], f[2] - b[2]];
        let dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if dd < 1e-4 {
            /* 前景色与背景色几乎相同（|F-B| ≈ 0）→ 方程欠定，解不出 α。
             * 这不是 bug：`I = αF + (1-α)B` 在 F=B 时对任何 α 都成立。
             * 取 0.5 是"既不敢当主体、也不敢当背景"的保守值，
             * 界面会通过 no_background 提示用户改用「手动补描」。 */
            alpha[i] = 0.5;
        } else {
            let num = (ic[0] - b[0]) * d[0] + (ic[1] - b[1]) * d[1] + (ic[2] - b[2]) * d[2];
            alpha[i] = (num / dd).clamp(0.0, 1.0);
        }
    }

    /* ---- 4. 边缘去色：把混合像素的 RGB 换成**纯前景色** ----
     *
     * ⚠ r79 修白边（放大对比 `tools/r79-zoom.js` 抓到的 Excalidraw 那格）：
     * 早先这里用反解 `F = (I - (1-α)B)/α`。公式没错，但它在 **α 很小时
     * 数值上不可靠**：α = 0.05 时 `I ≈ 0.95B + 0.05F`，与 B 只差一点点，
     * 反解要拿这个微小差值除以 0.05 —— 舍入误差被放大 20 倍，解出来接近背景色，
     * 在深色底上就是**一圈白边**。
     *
     * 改为直接把边缘像素的 RGB 置为估算前景色 F：反正 α 已经表达了
     * "有多少是前景"，颜色就该是前景色本身。这样无论 α 多小都不带背景色污染。
     *
     * 只处理 `0 < α < 1` 的混合像素：
     *   · α = 1 的像素保留原色（主体内部渐变/细节不能被抹平）
     *   · α = 0 的像素不必管（全透明，RGB 不影响显示） */
    for i in 0..n {
        let a = alpha[i];
        if !(0.001..0.999).contains(&a) {
            continue;
        }
        let f = f_map[i];
        let x = (i % w as usize) as u32;
        let y = (i / w as usize) as u32;
        let px = rgba.get_pixel_mut(x, y);
        px[0] = (f[0] * 255.0).clamp(0.0, 255.0) as u8;
        px[1] = (f[1] * 255.0).clamp(0.0, 255.0) as u8;
        px[2] = (f[2] * 255.0).clamp(0.0, 255.0) as u8;
    }

    /* ---- 5. 尊重原图自带的 alpha（上界） ----
     * 已经透明的像素不该被填上东西（单测 `already_transparent_is_noop` 钉的这条）。 */
    let raw = rgba.as_raw();
    for i in 0..n {
        let orig = raw[i * 4 + 3] as f32 / 255.0;
        if orig < 0.02 {
            alpha[i] = 0.0;
        } else {
            alpha[i] = alpha[i].min(orig);
        }
    }
    // 手动补描最后再钉一次（它的优先级最高）
    if let Some(k) = keep {
        for i in 0..n.min(k.len()) {
            if k[i] {
                alpha[i] = 1.0;
            }
        }
    }
    alpha
}

/// 对"确定背景"像素拟合二次曲面，得到**逐像素背景色**。
///
/// 基底 `[1, x, y, x², xy, y²]`（x/y 归一化到 [-1,1]：不归一化的话
/// `x²` 项能到 26 万，正规方程条件数会烂掉）。用正规方程 `AᵀA·c = Aᵀb` 解，
/// 加一个很小的 ridge（`1e-6·I`）防止某些基底在特定图上退化（比如全同色图）。
///
/// 为什么是二次：线性渐变（`a + bx + cy`）精确命中，径向渐变也能近似；
/// 再高的次数会过拟合到主体的颜色上（背景像素只在四周边带，中间没有样本）。
///
/// `#[allow(clippy::needless_range_loop)]`：6×6 高斯消元那两处用
/// `for c in col..9` 直白下标而不是迭代器 —— `m` 是固定尺寸 `[[f64; 9]; 6]`，
/// 循环变量同时用于**读写不同下标**，还要做"从某列到末尾"的范围切片；
/// 换迭代器要么拿不到列号、要么得 zip 一堆临时切片，反而更难核对。
#[allow(clippy::needless_range_loop)]
fn fit_background(
    rgba: &image::RgbaImage,
    tri: &[Tri],
    keep: Option<&[bool]>,
) -> Vec<[f32; 3]> {
    let (w, h) = rgba.dimensions();
    let n = (w as usize) * (h as usize);

    let mut ata = [[0f64; 6]; 6];
    let mut atb = [[0f64; 3]; 6];
    let mut cnt = 0f64;
    let wf = (w.max(2) - 1) as f64;
    let hf = (h.max(2) - 1) as f64;

    for (i, t) in tri.iter().enumerate().take(n) {
        if *t != Tri::Bg {
            continue;
        }
        if keep.map(|k| k.get(i).copied().unwrap_or(false)).unwrap_or(false) {
            continue; // 用户描过的像素不参与背景拟合
        }
        let x = (i % w as usize) as f64;
        let y = (i / w as usize) as f64;
        let nx = x / wf * 2.0 - 1.0;
        let ny = y / hf * 2.0 - 1.0;
        let f = [1.0, nx, ny, nx * nx, nx * ny, ny * ny];
        let p = rgba.get_pixel(x as u32, y as u32);
        for r in 0..6 {
            for c in 0..6 {
                ata[r][c] += f[r] * f[c];
            }
            for ch in 0..3 {
                atb[r][ch] += f[r] * p[ch] as f64 / 255.0;
            }
        }
        cnt += 1.0;
    }

    /* 样本太少（< 8 个背景像素）→ 没有可信的曲面可拟合，
     * 退化成"整张图一个平均色"。这里返回 length = n 的常量图。 */
    if cnt < 8.0 {
        let mut mean = [0f32; 3];
        let mut c2 = 0f64;
        for (i, t) in tri.iter().enumerate().take(n) {
            if *t != Tri::Bg {
                continue;
            }
            let x = (i % w as usize) as u32;
            let y = (i / w as usize) as u32;
            let p = rgba.get_pixel(x, y);
            mean[0] += p[0] as f32;
            mean[1] += p[1] as f32;
            mean[2] += p[2] as f32;
            c2 += 1.0;
        }
        if c2 > 0.0 {
            mean[0] /= c2 as f32;
            mean[1] /= c2 as f32;
            mean[2] /= c2 as f32;
        }
        return vec![mean; n];
    }

    // ridge：让正规方程可逆（全同色图的部分基底会秩亏）
    for (r, row) in ata.iter_mut().enumerate() {
        row[r] += 1e-6;
    }

    // 6×6 高斯消元（含 3 个右端项一起解）
    let mut m = [[0f64; 9]; 6];
    for r in 0..6 {
        for c in 0..6 {
            m[r][c] = ata[r][c];
        }
        for ch in 0..3 {
            m[r][6 + ch] = atb[r][ch];
        }
    }
    for col in 0..6 {
        // 选主元
        let mut piv = col;
        for r in (col + 1)..6 {
            if m[r][col].abs() > m[piv][col].abs() {
                piv = r;
            }
        }
        if m[piv][col].abs() < 1e-14 {
            continue;
        }
        m.swap(col, piv);
        let d = m[col][col];
        for c in col..9 {
            m[col][c] /= d;
        }
        for r in 0..6 {
            if r == col {
                continue;
            }
            let factor = m[r][col];
            if factor == 0.0 {
                continue;
            }
            for c in col..9 {
                m[r][c] -= factor * m[col][c];
            }
        }
    }

    // 逐像素求值
    let mut out = vec![[0f32; 3]; n];
    for y in 0..h {
        let ny = y as f64 / hf * 2.0 - 1.0;
        for x in 0..w {
            let nx = x as f64 / wf * 2.0 - 1.0;
            let f = [1.0, nx, ny, nx * nx, nx * ny, ny * ny];
            let i = (y as usize) * (w as usize) + (x as usize);
            let mut c = [0f32; 3];
            for ch in 0..3 {
                let mut v = 0.0;
                for k in 0..6 {
                    v += f[k] * m[k][6 + ch];
                }
                c[ch] = (v as f32).clamp(0.0, 1.0);
            }
            out[i] = c;
        }
    }
    out
}

/// 逐像素前景色：只给**未知像素**算，确定前景像素保留原色（不抹平内部细节）。
///
/// 做法：在未知像素周围的小窗口里找**确定前景**像素取均值；
/// 窗口从 4 逐级放大到 16，都没有就退到全局前景均值。
/// 只在未知像素上做，所以成本是 O(未知数 · 窗口)，而不是 O(全图 · 窗口)。
///
/// # 为什么只信"确定前景"像素
///
/// trimap 的 `Tri::Fg` 是**腐蚀过的**（收缩了 2~3 圈），所以这些像素是
/// 主体的**内部**，颜色纯净；抗锯齿那一圈（混合色）全部落在 `Unknown`，
/// 不会被当成前景样本。这正是去色能否准确的关键 ——
/// 若把边缘混合像素也算进样本，估出的 F 会偏白，去色后留下白边。
fn local_foreground(
    rgba: &image::RgbaImage,
    tri: &[Tri],
    keep: Option<&[bool]>,
) -> Vec<[f32; 3]> {
    let (w, h) = rgba.dimensions();
    let n = (w as usize) * (h as usize);
    let mut out = vec![[0f32; 3]; n];

    let is_fg = |i: usize| -> bool {
        tri[i] == Tri::Fg || keep.map(|k| k.get(i).copied().unwrap_or(false)).unwrap_or(false)
    };

    // 先拿一个全局前景均值兜底（原图里一个前景像素都没有时用它）
    let mut gmean = [0f32; 3];
    let mut gc = 0f64;
    for i in 0..n {
        if !is_fg(i) {
            continue;
        }
        let x = (i % w as usize) as u32;
        let y = (i / w as usize) as u32;
        let p = rgba.get_pixel(x, y);
        gmean[0] += p[0] as f32 / 255.0;
        gmean[1] += p[1] as f32 / 255.0;
        gmean[2] += p[2] as f32 / 255.0;
        gc += 1.0;
    }
    if gc > 0.0 {
        gmean[0] /= gc as f32;
        gmean[1] /= gc as f32;
        gmean[2] /= gc as f32;
    }

    for i in 0..n {
        let x = (i % w as usize) as i32;
        let y = (i / w as usize) as i32;
        // 确定前景像素用**自己的颜色**（保持主体内部细节）
        if is_fg(i) {
            let p = rgba.get_pixel(x as u32, y as u32);
            out[i] = [
                p[0] as f32 / 255.0,
                p[1] as f32 / 255.0,
                p[2] as f32 / 255.0,
            ];
            continue;
        }
        if tri[i] == Tri::Bg {
            continue; // 背景像素不需要前景色
        }

        // 未知像素：逐级放大窗口找确定前景
        let mut found = false;
        for rad in [4i32, 8, 16] {
            let mut acc = [0f32; 3];
            let mut c = 0f32;
            for dy in -rad..=rad {
                let yy = y + dy;
                if yy < 0 || yy >= h as i32 {
                    continue;
                }
                for dx in -rad..=rad {
                    let xx = x + dx;
                    if xx < 0 || xx >= w as i32 {
                        continue;
                    }
                    let j = (yy as usize) * (w as usize) + xx as usize;
                    if !is_fg(j) {
                        continue;
                    }
                    let p = rgba.get_pixel(xx as u32, yy as u32);
                    acc[0] += p[0] as f32 / 255.0;
                    acc[1] += p[1] as f32 / 255.0;
                    acc[2] += p[2] as f32 / 255.0;
                    c += 1.0;
                }
            }
            if c > 0.0 {
                out[i] = [acc[0] / c, acc[1] / c, acc[2] / c];
                found = true;
                break;
            }
        }
        if !found {
            out[i] = gmean;
        }
    }
    out
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

/// PNG 编码（图标必须保 alpha，所以恒走 PNG）。
pub fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("编码 PNG 失败：{e}"))?;
    Ok(buf)
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
#[cfg(test)]
mod tests {
    use super::*;

    /* ══════════════════════════════════════════════════════════════════════
     * r80：`matte()` 与本地抠图入口已删（用户要求「原来那个直接去掉」），
     * 所以这一层不再测"抠完之后长什么样"。
     *
     * `matting.rs` 现在的角色是 **AI 的边缘处理器**：AI 给出低分辨率 alpha，
     * 这里用 `build_trimap` + `solve_alpha` + `apply_alpha` 把边缘做干净。
     * 所以单测钉的是这套边缘处理里的**纯逻辑**部分。
     * ══════════════════════════════════════════════════════════════════════ */

    fn png_of(img: &image::RgbaImage) -> Vec<u8> {
        encode_png(img).expect("测试图编码不该失败")
    }

    /// 白底 + 深色圆：trimap 应当分出前景与背景（这是 AI 蒙版进来的入口）。
    #[test]
    fn trimap能分出前景与背景() {
        let img = white_bg_with_circle(96);
        let samples = estimate_background(&img);
        assert!(!samples.is_empty(), "白底图应当估出背景色");
        let (tri, (fg, bg, _unk)) = build_trimap(&img, &samples, 48, None);
        assert!(fg > 100, "圆内应当有确定前景，实际 {fg}");
        assert!(bg > 500, "四周应当有确定背景，实际 {bg}");
        // 圆心必是前景
        assert_eq!(tri[(48 * 96 + 48) as usize], Tri::Fg, "圆心应当是前景");
        /* 角落：⚠ **不能**断言它是 Bg。
         * `build_trimap` 的形态学步骤会对背景做**腐蚀**（把背景向内收 r 圈），
         * 而贴图像边框的那一圈在腐蚀后必然落到未知带 —— 这是**有意的**：
         * 贴边像素本来就最可疑（可能是主体顶满，也可能是背景）。
         * 它们交给解混时 I≈B，α 自然算成 0，不会误留。
         * 所以要断言的是"角落**不是**确定前景"，而不是"角落是背景"。 */
        assert_ne!(
            tri[0],
            Tri::Fg,
            "左上角不该被判定为确定前景（它最多是未知/背景）"
        );
    }

    /// **手动补描是硬约束**：描过的像素无论颜色如何都必须是前景。
    /// 这条是用户明确要的行为（"描过的地方一定保留"）。
    #[test]
    fn 补描区域一定是前景() {
        let img = white_bg_with_circle(64);
        let samples = estimate_background(&img);
        let mut keep = vec![false; 64 * 64];
        // 在角落（本来是背景）描一块
        for y in 2..14u32 {
            for x in 2..14u32 {
                keep[(y * 64 + x) as usize] = true;
            }
        }
        let (tri, _) = build_trimap(&img, &samples, 48, Some(&keep));
        for y in 2..14u32 {
            for x in 2..14u32 {
                assert_eq!(tri[(y * 64 + x) as usize], Tri::Fg, "描过的 ({x},{y}) 必须是前景");
            }
        }
    }

    /// 全透明的图不该被"补"上东西 —— 原 alpha 是上界。
    #[test]
    fn 全透明图保持透明() {
        let img = image::RgbaImage::new(32, 32); // 全 0
        let samples = estimate_background(&img);
        let (tri, _) = build_trimap(&img, &samples, 48, None);
        let alpha = solve_alpha(&mut img.clone(), &tri, None);
        for (i, a) in alpha.iter().enumerate() {
            assert_eq!(*a, 0.0, "第 {i} 个像素本该透明，却算成了 {a}");
        }
    }

    /// 背景像素的 alpha 必须是 0、前景必须是 1（定值不被求解改动）。
    #[test]
    fn 定值不会被改动() {
        let img = white_bg_with_circle(64);
        let samples = estimate_background(&img);
        let (tri, _) = build_trimap(&img, &samples, 48, None);
        let alpha = solve_alpha(&mut img.clone(), &tri, None);
        for (i, t) in tri.iter().enumerate() {
            match t {
                Tri::Bg => assert_eq!(alpha[i], 0.0, "背景像素 alpha 应为 0"),
                Tri::Fg => assert_eq!(alpha[i], 1.0, "前景像素 alpha 应为 1"),
                Tri::Unknown => {}
            }
        }
    }

    /// 补描优先级最高：即使某个像素被 AI/解混判成背景，描过也要变回 1。
    #[test]
    fn 补描优先级高于求解结果() {
        let img = white_bg_with_circle(64);
        let samples = estimate_background(&img);
        let (tri, _) = build_trimap(&img, &samples, 48, None);
        let mut keep = vec![false; 64 * 64];
        keep[0] = true; // 左上角（背景）
        let alpha = solve_alpha(&mut img.clone(), &tri, Some(&keep));
        assert_eq!(alpha[0], 1.0, "描过的背景像素必须被强制成前景");
    }

    /// 坏输入要报错（不是 panic）。
    #[test]
    fn 坏输入报错() {
        assert!(prepare(b"not an image").is_err());
        assert!(prepare(&[]).is_err());
    }

    /// 编码出的 PNG 必须能被解回来（AI 结果要经 IPC 传给界面）。
    #[test]
    fn 编码可往返() {
        let img = white_bg_with_circle(32);
        let bytes = png_of(&img);
        let back = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(back.dimensions(), (32, 32));
    }
}
