//! 图标编辑器（#143）：一键消除背景。
//!
//! 用户原话：「当用户选择一个图标后，弹出一个专用的图标编辑页面。该编辑页面
//! 必须包含一个'一键消除背景'按钮，点击后自动识别并去除图标背景，仅保留主体
//! 部分；同时提供编辑前后对比预览、保存及取消等操作……最终处理结果能正确
//! 更新到原图标上」。
//!
//! 本文件只放**纯算法 + 会话状态**（不依赖 Tauri / 窗口 / 配置锁，方便单测）；
//! 命令、建窗、落库都在 main.rs。
//!
//! # 算法口径（泛洪 + 容差 + 羽化）
//!
//! 1. **取样**：把四条边上的像素按 5bit/通道量化成颜色桶（出现 ≥2 次才留，
//!    最多 256 个，按出现次数降序）—— 背景不一定是纯色，渐变/照片底也能
//!    覆盖到主要那几个色。
//! 2. **泛洪**：从所有「像背景」的边界像素出发做 4 邻域 BFS。判据两条，
//!    任一命中即算背景：
//!    · 颜色进桶（欧氏 RGB 距离 ≤ 容差）；
//!    · alpha < 250（本来就透明/半透明 —— 泛洪要能**穿过**它，否则老早抠过角的 PNG 会把泛洪堵死在边框一圈）。
//!    4 邻域而不是 8 邻域：对角线漏过去会把两个本不相连的区域连起来。
//! 3. **抠掉**：命中的像素 alpha 归零。**只抠与四边连成一片的**——主体内部
//!    封闭区域里的同色像素（字母镂空、圆环窟窿）不在泛洪路径上，原样保留，
//!    这正是「仅保留主体部分」想要的语义（和 Photoshop 魔术棒Contiguous 一致）。
//! 4. **羽化**：只给**边界像素**做一次 3×3 alpha 平均 —— 内部全不碰，
//!    避免把实心块糊成毛玻璃；边界平均后主体边缘出现一级抗锯齿，
//!    不会像剪刀剪的一样锯齿轮廓。
//!
//! 已知边界情况（页面有前后对比 + 取消兜底，算法不追求全自动完美）：
//!   · 主体顶满四边（没有露出的底色）时，边上的主体色会进桶 —— 这类图
//!     本来就没有背景，用户也不该点这个按钮；点了会看到预览不对，取消即可。
//!   · 半透明主体（alpha 100 且颜色不像背景）不会被抠掉，但泛洪会穿过它
//!     （它背后的同色背景仍会被正确抠除）。

use std::collections::VecDeque;

/// 一次编辑器会话：进程级单例（编辑器一次只开一个窗口）。
#[derive(Clone, Debug, serde::Serialize)]
pub struct IconEditSession {
    /// overrideIcons 的键：引擎名 / `@app:<id>` / `@fav:<id>` / `@ocr`。
    pub key: String,
    /// 给人看的名字（编辑器标题用，不用哨兵原文）。
    pub name: String,
    /// 原图的 data URL（也可能是 `data/icons/<file>` 相对路径 —— 前端
    /// 对内置图标的兜底，Rust 侧按需读资源文件）。
    pub src: String,
    /// 是不是矢量图（SVG 没有位图背景可消，页面据此禁用按钮）。
    pub vector: bool,
}

static SESSION: std::sync::OnceLock<std::sync::Mutex<Option<IconEditSession>>> =
    std::sync::OnceLock::new();

fn slot() -> &'static std::sync::Mutex<Option<IconEditSession>> {
    SESSION.get_or_init(|| std::sync::Mutex::new(None))
}

pub fn set_session(s: IconEditSession) {
    if let Ok(mut g) = slot().lock() {
        *g = Some(s);
    }
}

/// 取出会话的克隆；没有会话返回 None（页面 boot 时先拉一次）。
pub fn load_session() -> Option<IconEditSession> {
    slot().lock().ok().and_then(|g| g.clone())
}

pub fn clear_session() {
    if let Ok(mut g) = slot().lock() {
        *g = None;
    }
}

/// 长边超过这个值的图先缩小再处理：图标显示尺寸 ≤ 64px，512 有足够编辑
/// 余量；而用户完全可能从图库里挑一张 4000×3000 的照片来当图标，
/// 不缩的话泛洪 + 编码要多花一个数量级的时间。
const MAX_EDGE: u32 = 512;

/// 用户手描的「这块是主体，别抠」保护蒙版（r77）。
///
/// 前端在「编辑前」那张图上用画笔涂出来，按 canvas 尺寸送单通道数据过来
/// （非零 = 保护）。后端负责把它投到**当前处理尺寸**上 —— 因为图可能在
/// `remove_background` 里已经被缩到 `MAX_EDGE`，两份网格必须对齐，
/// 否则保护区域会整体偏移（用户看到的是"描了还是被吃"）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct KeepMask {
    pub w: u32,
    pub h: u32,
    /// 长度必须是 `w * h`；非零 = 保护
    pub data: Vec<u8>,
}

/// 与 `win::log` 同口径的轻量日志：这个模块不依赖 win，测试里也不该拉进来。
fn win_log(msg: &str) {
    // 真机看日志靠 main.rs 那一侧；这里只在带 QS_DEBUG 时打到 stderr，
    // 单测里默认不输出（避免污染测试输出）。
    if std::env::var("QS_DEBUG").map(|v| v == "1").unwrap_or(false) {
        eprintln!("[iconedit] {msg}");
    }
}

/// 把一张位图的「与四边连成一片的底色」抠成透明。
///
/// `tolerance` = 颜色判据的欧氏 RGB 距离（0 严格相等 ~ 150 很宽松），
/// 页面滑块给 10–120，默认 48。
///
/// `keep` = **手动描边保护蒙版**（r77），可选。格式与图片同尺寸的灰度/任意
/// 通道数据：非零 = 这一块是主体，**泛洪不许穿过它**。
/// 为什么需要它：用户原话「当前编辑图标的一键消除背景功能，它会把图标的主体
/// 内容也会消除掉，所以有需要在一键消除背景之前还要先进行手动描边」。
/// 典型情形是浅色主体 + 浅色背景（白色 logo 落在白底上），颜色判据分不开，
/// 泛洪会从边缘一路吃进主体。描一圈就能把它挡住。
///
/// 返回 `(PNG 字节, 被抠掉的像素数)`。抠掉 0 个像素通常意味着这张图已经是
/// 透明底、或者四边没有连成片的底色 —— 调用方据此给用户一句明确的话。
pub fn remove_background(
    bytes: &[u8],
    tolerance: u32,
    keep: Option<&KeepMask>,
) -> Result<(Vec<u8>, usize), String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("这张图解不开（{}），换个 PNG/JPEG 试试", e))?;
    let mut rgba = img.to_rgba8();
    let (w0, h0) = rgba.dimensions();
    if w0 > MAX_EDGE || h0 > MAX_EDGE {
        let (nw, nh) = if w0 >= h0 {
            (MAX_EDGE, (h0 as u64 * MAX_EDGE as u64 / w0 as u64).max(1) as u32)
        } else {
            ((w0 as u64 * MAX_EDGE as u64 / h0 as u64).max(1) as u32, MAX_EDGE)
        };
        rgba = image::imageops::resize(&rgba, nw, nh, image::imageops::FilterType::Triangle);
    }
    let (w, h) = rgba.dimensions();
    if w < 2 || h < 2 {
        return Err("图太小了（至少 2×2）".to_string());
    }

    /* r77：把描边蒙版缩放到**和当前处理尺寸一致**。
     * 前端画蒙版时用的是它自己那块 canvas 的尺寸（可能和原图不同），
     * 而且上面可能已经把图缩到 MAX_EDGE 了 —— 两处任何一处没对齐，
     * 保护区域就会整体偏移，用户看到的是"描了但还是被吃"。 */
    let keep_mask: Option<Vec<bool>> = keep.and_then(|m| {
        if m.w == 0 || m.h == 0 || m.data.len() != (m.w as usize) * (m.h as usize) {
            return None;   // 形状对不上就当没描过，按老路走（不因为蒙版坏了就整条失败）
        }
        let n = (w as usize) * (h as usize);
        let mut outv = vec![false; n];
        let mut any = false;
        for y in 0..h {
            // 最近邻：保护蒙版是二值的，插值只会把边界糊开
            let sy = ((y as u64 * m.h as u64) / h as u64).min(m.h as u64 - 1) as u32;
            for x in 0..w {
                let sx = ((x as u64 * m.w as u64) / w as u64).min(m.w as u64 - 1) as u32;
                if m.data[(sy as usize) * (m.w as usize) + (sx as usize)] != 0 {
                    outv[(y as usize) * (w as usize) + (x as usize)] = true;
                    any = true;
                }
            }
        }
        // 一个点都没描 = 没保护（与 None 等价，日志里能看出来）
        if any {
            win_log(&format!("iconedit: 描边保护蒙版生效（{}×{} → {}×{}）", m.w, m.h, w, h));
            Some(outv)
        } else {
            None
        }
    });

    // —— 1. 边沿取样 → 颜色桶 ——
    let mut buckets = background_buckets(&rgba);
    if buckets.is_empty() {
        // 四边一个不透明像素都没有（全透明图）：没什么可抠的
        return Ok((encode_png(&rgba)?, 0));
    }
    // 按出现次数降序，判色时先比常见的：纯色底一步命中，
    // 渐变底也能在几桶内找到 —— 省得每像素遍历全部桶。
    buckets.sort_unstable_by_key(|a| std::cmp::Reverse(a.1));

    let tol2 = (tolerance as i64) * (tolerance as i64);
    /* 描边保护的判定：`keep[i]` 为真就**既不当种子也不许扩散进来**。
     * 用它挡的是"颜色像背景、但用户说是主体"的那一块。 */
    let protected = |i: usize| -> bool {
        match keep_mask.as_ref() {
            Some(m) => m.get(i).copied().unwrap_or(false),
            None => false,
        }
    };
    // —— 2. 泛洪：从所有"像背景"的边界像素出发 ——
    let mut bg = vec![false; (w * h) as usize];
    let mut q: VecDeque<u32> = VecDeque::new();
    let push_if = |x: u32, y: u32, bg: &mut Vec<bool>, q: &mut VecDeque<u32>| {
        let i = (y * w + x) as usize;
        if bg[i] || protected(i) {
            return;
        }
        let p = rgba.get_pixel(x, y);
        let like = p[3] < 250 || color_in_buckets(p, &buckets, tol2);
        if like {
            bg[i] = true;
            q.push_back(i as u32);
        }
    };
    for x in 0..w {
        push_if(x, 0, &mut bg, &mut q);
        push_if(x, h - 1, &mut bg, &mut q);
    }
    for y in 0..h {
        push_if(0, y, &mut bg, &mut q);
        push_if(w - 1, y, &mut bg, &mut q);
    }
    while let Some(i) = q.pop_front() {
        let (x, y) = (i % w, i / w);
        for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                continue;
            }
            let (nx, ny) = (nx as u32, ny as u32);
            let j = (ny * w + nx) as usize;
            if bg[j] || protected(j) {
                continue;
            }
            let p = rgba.get_pixel(nx, ny);
            if p[3] < 250 || color_in_buckets(p, &buckets, tol2) {
                bg[j] = true;
                q.push_back(j as u32);
            }
        }
    }

    // —— 3. 抠掉 + 4. 边界羽化（同一遍扫出来）——
    let mut out = rgba.clone();
    let mut removed = 0usize;
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if !bg[i] {
                continue;
            }
            let p = rgba.get_pixel(x, y);
            // 半透明但颜色不像背景的像素（半透明主体）不抠，见模块注释
            let kill = p[3] < 8 || color_in_buckets(p, &buckets, tol2);
            if !kill {
                continue;
            }
            if p[3] > 0 {
                removed += 1;
            }
            out.get_pixel_mut(x, y)[3] = 0;
        }
    }
    if removed > 0 {
        feather_boundary(&mut out, &bg, w, h);
    }
    Ok((encode_png(&out)?, removed))
}

/// 四边像素量化成颜色桶：`(精确代表色, 出现次数)`。
///
/// 量化只用来**归并**同类色（一张照片底能归并出几千个桶，不归并判色要遍历
/// 几千次）；桶里存的是**第一个落桶的精确颜色**而不是区间中点 —— 存中点的
/// 话容差 0 反而匹配不上原色（量化本身就带 ±4 的误差），「容差 0 = 只抠
/// 完全相同的色」这个直觉就没了。
fn background_buckets(rgba: &image::RgbaImage) -> Vec<([u8; 3], u32)> {
    use std::collections::HashMap;
    let (w, h) = rgba.dimensions();
    // key = 5bit 量化色；value = (精确代表色, 次数)
    let mut map: HashMap<[u8; 3], ([u8; 3], u32)> = HashMap::new();
    let add = |x: u32, y: u32, map: &mut HashMap<[u8; 3], ([u8; 3], u32)>| {
        let p = rgba.get_pixel(x, y);
        if p[3] < 250 {
            return; // 透明的边不贡献颜色桶（泛洪能穿过它就行）
        }
        let key = [p[0] >> 3, p[1] >> 3, p[2] >> 3];
        let e = map.entry(key).or_insert(([p[0], p[1], p[2]], 0));
        e.1 += 1;
    };
    for x in 0..w {
        add(x, 0, &mut map);
        add(x, h - 1, &mut map);
    }
    for y in 0..h {
        add(0, y, &mut map);
        add(w - 1, y, &mut map);
    }
    let mut out: Vec<([u8; 3], u32)> = map
        .into_iter()
        .filter(|(_, (_, n))| *n >= 2)
        .map(|(_, v)| v)
        .collect();
    out.sort_unstable_by_key(|a| std::cmp::Reverse(a.1));
    out.truncate(256);
    out
}

fn color_in_buckets(p: &image::Rgba<u8>, buckets: &[([u8; 3], u32)], tol2: i64) -> bool {
    let pr = p[0] as i64;
    let pg = p[1] as i64;
    let pb = p[2] as i64;
    for (c, _) in buckets {
        let dr = pr - c[0] as i64;
        let dg = pg - c[1] as i64;
        let db = pb - c[2] as i64;
        if dr * dr + dg * dg + db * db <= tol2 {
            return true;
        }
    }
    false
}

/// 只给**边界像素**（抠/不抠状态与某个 4 邻域不同的那些）做 3×3 alpha 平均。
/// 内部像素一律不碰 —— 实心区域糊一刀会显得发虚。
fn feather_boundary(out: &mut image::RgbaImage, bg: &[bool], w: u32, h: u32) {
    let snap = out.clone();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let edge = (x > 0 && bg[i - 1] != bg[i])
                || (x + 1 < w && bg[i + 1] != bg[i])
                || (y > 0 && bg[i - w as usize] != bg[i])
                || (y + 1 < h && bg[i + w as usize] != bg[i]);
            if !edge {
                continue;
            }
            let (mut sum, mut n) = (0u32, 0u32);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    sum += snap.get_pixel(nx as u32, ny as u32)[3] as u32;
                    n += 1;
                }
            }
            out.get_pixel_mut(x, y)[3] = (sum / n) as u8;
        }
    }
}

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    // write_to 要 Write + Seek：Vec 没有 Seek，套 Cursor（ocr.rs 同款写法）
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    /// 红底 + 居中白色圆（半径 20）的 64×64 图 —— 消除背景的靶子。
    fn target() -> RgbaImage {
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 31.5;
            let dy = y as f64 - 31.5;
            *p = if dx * dx + dy * dy <= 20.0 * 20.0 {
                Rgba([255, 255, 255, 255])
            } else {
                Rgba([220, 30, 30, 255])
            };
        }
        img
    }

    fn png_of(img: &RgbaImage) -> Vec<u8> {
        let mut v = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut v, image::ImageFormat::Png)
            .unwrap();
        v.into_inner()
    }

    fn alpha_at(bytes: &[u8], x: u32, y: u32) -> u8 {
        let img = image::load_from_memory(bytes).unwrap().to_rgba8();
        img.get_pixel(x, y)[3]
    }

    #[test]
    fn removes_solid_background_keeps_subject() {
        let (out, removed) = remove_background(&png_of(&target()), 48, None).unwrap();
        assert!(removed > 2500, "红底应被成片抠掉，实际 {removed}");
        // 四角是背景 → 全透
        for (x, y) in [(0, 0), (63, 0), (0, 63), (63, 63), (2, 2)] {
            assert_eq!(alpha_at(&out, x, y), 0, "({x},{y}) 应透明");
        }
        // 圆心是主体 → 不透
        assert_eq!(alpha_at(&out, 32, 32), 255);
        // 主体内部（离边缘远，不吃羽化）必须全实
        assert_eq!(alpha_at(&out, 32, 25), 255);
        // 主体上沿贴着背景，会被羽化削掉一部分 alpha（抗锯齿），
        // 但绝不能清零 —— 清零就说明主体被背景一起吃掉了
        assert!(alpha_at(&out, 32, 12) > 100, "主体上沿应保留（羽化后）");
    }

    #[test]
    fn tolerance_zero_still_removes_exact_color() {
        let (out, removed) = remove_background(&png_of(&target()), 0, None).unwrap();
        assert!(removed > 2500);
        assert_eq!(alpha_at(&out, 0, 0), 0);
        assert_eq!(alpha_at(&out, 32, 32), 255);
    }

    #[test]
    fn tight_tolerance_keeps_gradient_background() {
        // 横向渐变底（每列一个色）：容差 8 时相邻列差 4 仍在泛洪路径上
        // （泛洪穿过"像背景"的像素，容差只决定起点邻域能走多远），
        // 但**颜色完全不像起点**的主体仍必须活下来。
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 31.5;
            let dy = y as f64 - 31.5;
            *p = if dx * dx + dy * dy <= 15.0 * 15.0 {
                Rgba([0, 0, 0, 255])
            } else {
                Rgba([(x * 4) as u8, 128, 200, 255])
            };
        }
        let (out, removed) = remove_background(&png_of(&img), 8, None).unwrap();
        assert_eq!(alpha_at(&out, 32, 32), 255, "主体必须保留");
        assert_eq!(alpha_at(&out, 0, 0), 0, "起点色必须抠掉");
        assert!(removed > 100);
    }

    #[test]
    fn already_transparent_is_noop() {
        let mut img = RgbaImage::new(32, 32);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 15.5;
            let dy = y as f64 - 15.5;
            *p = if dx * dx + dy * dy <= 10.0 * 10.0 {
                Rgba([10, 200, 90, 255])
            } else {
                Rgba([0, 0, 0, 0])
            };
        }
        let (out, removed) = remove_background(&png_of(&img), 48, None).unwrap();
        assert_eq!(removed, 0, "已经透明的图不该再抠任何像素");
        assert_eq!(alpha_at(&out, 16, 16), 255, "主体原样保留");
        assert_eq!(alpha_at(&out, 0, 0), 0);
    }

    #[test]
    fn interior_hole_survives() {
        // 甜甜圈：外圈白、中间镂空露出红底 —— 镂空与四边不相连，
        // 必须保留（"仅保留主体"不包含把主体内部的同色背景也抠了）。
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f64 - 31.5;
            let dy = y as f64 - 31.5;
            let d = (dx * dx + dy * dy).sqrt();
            *p = if (14.0..=24.0).contains(&d) {
                Rgba([255, 255, 255, 255])
            } else {
                Rgba([220, 30, 30, 255])
            };
        }
        let (out, _) = remove_background(&png_of(&img), 48, None).unwrap();
        assert_eq!(alpha_at(&out, 32, 32), 255, "中间的红色镂空要留下");
        assert_eq!(alpha_at(&out, 32, 32 - 19), 255, "白圈主体要留下");
        assert_eq!(alpha_at(&out, 0, 0), 0, "四角的红底要抠掉");
    }

    #[test]
    fn oversized_image_is_downscaled() {
        let mut img = RgbaImage::new(600, 400);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = if x < 590 && y < 390 {
                Rgba([255, 255, 255, 255])
            } else {
                Rgba([0, 0, 0, 255])
            };
        }
        let (out, _) = remove_background(&png_of(&img), 48, None).unwrap();
        let got = image::load_from_memory(&out).unwrap();
        assert_eq!(got.width(), 512);
        assert!(got.height() < 512, "短边按比例缩，实际 {}", got.height());
    }

    #[test]
    fn garbage_input_errors() {
        assert!(remove_background(b"not an image at all", 48, None).is_err());
        assert!(remove_background(&[], 48, None).is_err());
    }

    #[test]
    fn tiny_image_errors() {
        let img = RgbaImage::new(1, 1);
        assert!(remove_background(&png_of(&img), 48, None).is_err());
    }

    /* ---------------- r77：手动描边保护 ---------------- */

    /// 造一张"浅色主体落在浅色底上"的图 —— 这正是描边要救的场景：
    /// 不描的话泛洪会从边缘一路吃进主体（颜色判据分不开）。
    fn low_contrast_icon() -> RgbaImage {
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            // 底 #F8F8F8，主体 #E8E8E8 —— 只差 16，容差 48 时必然被当成底
            let inside = (20..44).contains(&x) && (20..44).contains(&y);
            *p = if inside {
                Rgba([0xE8, 0xE8, 0xE8, 255])
            } else {
                Rgba([0xF8, 0xF8, 0xF8, 255])
            };
        }
        img
    }

    #[test]
    fn 不描边时浅色主体会被当背景吃掉() {
        let img = low_contrast_icon();
        let (out, removed) = remove_background(&png_of(&img), 48, None).unwrap();
        // 整张图颜色差只有 16，泛洪会一路吃光 —— 这就是用户报的"主体也被消除"
        assert!(removed > 3000, "不保护时应当几乎整张都被抠，实际 {removed}");
        assert_eq!(alpha_at(&out, 32, 32), 0, "主体中心（不保护时）应当被吃掉");
    }

    #[test]
    fn 描边保护挡住泛洪主体就保住了() {
        let img = low_contrast_icon();
        // 在主体外围描一圈（粗笔）：坐标是 64×64 网格
        let mut data = vec![0u8; 64 * 64];
        for y in 0..64u32 {
            for x in 0..64u32 {
                let on_ring = (18..46).contains(&x) && (18..46).contains(&y)
                    && !((22..42).contains(&x) && (22..42).contains(&y));
                if on_ring {
                    data[(y * 64 + x) as usize] = 255;
                }
            }
        }
        let mask = KeepMask { w: 64, h: 64, data };
        let (out, _removed) = remove_background(&png_of(&img), 48, Some(&mask)).unwrap();
        // 关键断言：主体中心**活下来了**
        assert_eq!(
            alpha_at(&out, 32, 32),
            255,
            "描边保护之后主体中心必须还是不透明的"
        );
        // 而描边圈外面（真正连到四边的底色）仍然被抠掉
        assert_eq!(alpha_at(&out, 2, 2), 0, "四角是底色，还是该抠掉");
    }

    /// 蒙版尺寸和处理尺寸不一致时（前端画布 ≠ 原图），要按比例投过去，
    /// 不能整块错位、也不能因为形状对不上就把整条命令判失败。
    #[test]
    fn 蒙版尺寸不同也能按比例投过去() {
        let img = low_contrast_icon();
        // 蒙版用 32×32（原图 64×64）：主体大概在 10..22
        let mut data = vec![0u8; 32 * 32];
        for y in 0..32u32 {
            for x in 0..32u32 {
                let on_ring = (9..23).contains(&x) && (9..23).contains(&y)
                    && !((11..21).contains(&x) && (11..21).contains(&y));
                if on_ring {
                    data[(y * 32 + x) as usize] = 255;
                }
            }
        }
        let mask = KeepMask { w: 32, h: 32, data };
        let (out, _) = remove_background(&png_of(&img), 48, Some(&mask)).unwrap();
        assert_eq!(
            alpha_at(&out, 32, 32),
            255,
            "蒙版缩放之后主体中心仍须保住"
        );
    }

    /// 形状对不上的坏蒙版（长度 ≠ w*h）→ 当没描过，走老路，**不能报错**。
    #[test]
    fn 坏蒙版退回不保护而不是报错() {
        let img = low_contrast_icon();
        let bad = KeepMask { w: 10, h: 10, data: vec![255u8; 3] };
        let r = remove_background(&png_of(&img), 48, Some(&bad));
        assert!(r.is_ok(), "坏蒙版不该让整条命令失败");
        let (out, _) = r.unwrap();
        assert_eq!(alpha_at(&out, 32, 32), 0, "当没保护处理 → 主体被吃（与 None 一致）");
    }

    /// 全零蒙版（用户进了描边模式但一笔没画）→ 等价于没保护。
    #[test]
    fn 空蒙版等价于没描过() {
        let img = low_contrast_icon();
        let mask = KeepMask { w: 64, h: 64, data: vec![0u8; 64 * 64] };
        let (out, removed) = remove_background(&png_of(&img), 48, Some(&mask)).unwrap();
        assert!(removed > 3000, "空蒙版不该改变结果，实际 {removed}");
        assert_eq!(alpha_at(&out, 32, 32), 0);
    }
}
