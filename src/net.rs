//! 网络小工具：把「本机踩过的坑」收在一处，所有 HTTP 客户端共用。
//!
//! 目前只有一个东西 —— `ipv4_first`，但它是**全程序第二重要的性能开关**
//! （第一是别在主线程上等网络）。原因见下。

use std::net::{SocketAddr, ToSocketAddrs};
use std::time::Duration;

/// DNS 解析器：把 IPv4 地址排到 IPv6 前面（给 `ureq::AgentBuilder::resolver` 用）。
///
/// # 为什么这不是「优化」，是绕开一个只能靠超时才发现的大坑
///
/// Windows 的 `getaddrinfo` 按「前缀策略」排序，默认 IPv6（`::/0`，优先级 40）
/// 排在 IPv4（`::ffff:0:0/96`，优先级 35）前面。可如果这台机器**有**全局 IPv6
/// 地址、**也有** IPv6 默认路由，而实际上游是黑的（路由器播发了 IPv6 前缀、
/// 整条链路却不通），那么连 IPv6 就是「包发出去没人理」——既不会立刻报错，
/// 也没有 RST，只能干等超时。这类「假 IPv6」的家用宽带一点都不罕见。
///
/// 而 `ureq` 是**按 `getaddrinfo` 返回的顺序逐个地址试**的
/// （ureq `stream.rs::connect_host`：`for sock_addr in sock_addrs`），
/// 所以每个请求都得先白等一次 IPv6 连接超时，才回退到 IPv4。
///
/// # 本机实测（2026-10「百度识图好慢」的**真**根因）
///
/// ```text
/// getaddrinfo 顺序： 2408:8756:... （IPv6 优先）×2，然后 163.177... ×2
/// IPv4 直连：        14~27 ms 就能通
/// IPv6 直连：        6.0s 超时（两个地址都超时）
/// ```
///
/// 于是 `graph.baidu.com` 的上传在程序里要 **6.6 秒**（日志实证
/// `img: baidu 上传完成，开结果页（6613ms）`），而同一个请求换成 IPv4
/// 只要 **0.6~1.0 秒**。用户的原话就是「识图搜索用百度引擎来搜索图片，
/// 速度真的好慢好慢，要等好多秒才能打开新标签」。
///
/// 曾经在 `ocr.rs` 里单独给 OCR 请求修过一次（AI 识别接口同样慢），
/// 后来发现**所有** ureq 客户端（识图上传 / 模型下载 / WebDAV 同步 /
/// 检查更新）都中同一个招 —— 所以把它提到这里，谁建 Agent 谁挂上。
///
/// # 代价
///
/// 只有真没有 A 记录（纯 IPv6 主机）时才会走 IPv6，行为不变；
/// 同族地址之间保持原有相对顺序（`sort_by_key` 是稳定排序）。
///
/// ⚠ `netloc` 形如 `"aip.baidubce.com:443"`。
pub(crate) fn ipv4_first(netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
    let mut addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
    addrs.sort_by_key(|a| a.is_ipv6());
    Ok(addrs)
}

/// 翻译专用 Agent：**复用连接池**。
///
/// # 为什么它和 OCR 那条路不一样
///
/// `ocr::agent()` 的注释写着「故意每次新建 Agent，别改成 static」—— 那是给
/// **识图/识别**这类"点一次发一发"的请求做的取舍：省一次握手不值当为
/// 「复用到服务器已经关掉的空闲连接」冒风险。
///
/// 翻译的用法完全不同：用户会**连着翻好几次**（改两个词再翻、换个语言再翻、
/// 同时翻三四家），而且一次翻译里还会跑 A/B 两家对比。这时候每条请求都重新
/// DNS + TCP + TLS（境内 60~150ms，境外 200~400ms）就是实打实压在用户身上的
/// 等待 —— 一次翻译体感上的"卡一下"，很大一块在这里。
///
/// 复用的风险（空闲连接被对端关掉）用**一次重试**兜住，见
/// [`crate::trans::translate_stream`] 与 [`crate::trans_vendor`] 的 `post_form`：
/// 真撞上就直接重发一次，代价是一轮 RTT，比每次都付握手便宜得多。
///
/// # 超时为什么这么给
///
/// · `timeout_read` 60s：**流式**响应里两个 chunk 之间的最长间隔，不是总时长。
///   模型偶尔"想一想"才吐下一个字，60 秒足够宽容，又不会真卡死。
/// · `timeout` 180s：整轮上限。长段落逐字生成可能超过 45 秒（OCR 那边的口径），
///   卡在 45 秒会把好端端的长文翻译掐断。
pub(crate) fn trans_agent() -> ureq::Agent {
    static A: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    A.get_or_init(|| {
        ureq::AgentBuilder::new()
            // 同 ipv4_first 的理由：假 IPv6 会让每条请求先白等 6 秒
            .resolver(ipv4_first)
            .timeout_connect(Duration::from_secs(6))
            .timeout_read(Duration::from_secs(60))
            .timeout(Duration::from_secs(180))
            .user_agent("QuickSearch/1.0 (Windows)")
            .build()
    })
    .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv4_before_ipv6() {
        // localhost 同时有 127.0.0.1 和 ::1（几乎肯定），解析后 IPv4 必须在前。
        let addrs = ipv4_first("localhost:80").expect("localhost 应该能解析");
        assert!(!addrs.is_empty());
        let first_v6 = addrs.iter().position(|a| a.is_ipv6());
        let last_v4 = addrs.iter().rposition(|a| a.is_ipv4());
        if let (Some(v6), Some(v4)) = (first_v6, last_v4) {
            assert!(v4 < v6, "IPv4 没有排到 IPv6 前面：{addrs:?}");
        }
    }

    #[test]
    fn ipv4_first_keeps_relative_order() {
        // 同族之间的相对顺序不能被 sort_by_key 打乱（它是稳定排序）。
        let addrs = ipv4_first("localhost:80").expect("localhost 应该能解析");
        let v4: Vec<SocketAddr> = addrs.iter().copied().filter(|a| a.is_ipv4()).collect();
        let mut sorted = v4.clone();
        sorted.sort_by_key(|a| a.is_ipv6());
        assert_eq!(v4, sorted);
    }
}
