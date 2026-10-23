//! 备份加密：AES-256-GCM + Argon2id 派生密钥。
//!
//! 用户要求：「备份的数据很多是敏感的，备份时要加密。算法要性能开销小、
//! 但破解难度高」。
//!
//! 选型：
//!   · **AES-256-GCM** —— 硬件加速（AES-NI），加密速度是几百 MB/s 级，
//!     同时带认证（改一个字节都解不开），是"快且难破"的标准答案；
//!   · **Argon2id** 派生密钥 —— 密码学里抗暴力破解最强的 KDF（内存困难），
//!     用 OWASP 推荐参数（m=19MiB, t=2, p=1）。一次派生几十毫秒，
//!     备份/恢复各只做一次，用户无感；但攻击者每猜一个密码都要付同样的代价。
//!
//! 两种信封（都是"人能看出这是密文"的 JSON，坏不了）：
//!
//! ```json
//! { "qsEnc": 1, "kdf": "argon2id", "salt": "...", "nonce": "...", "data": "..." }
//! { "qsEnc": 2, "alg": "dpapi", "data": "..." }
//! ```
//!
//! `qsEnc:1` = **用备份密码加密**（可跨机，用户 v1.4.0 选的口径）；
//! `qsEnc:2` = **Windows DPAPI 加密**（跟当前用户账户走，不需要密码）——
//! 只在"还没有备份密码"这种首次运行状态下兜底，保证磁盘上永远没有明文。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

// base64 用 config.rs 里现成的那套（项目没引 base64 crate，不为一处用途加依赖）
use crate::config::{base64 as b64_encode, base64_decode};

/// 备份文件里标记"这是加密的"的字段名 / 版本号
const MAGIC: &str = "qsEnc";
/// Argon2id 参数（OWASP 推荐：19MiB / t=2 / p=1）
const ARGON_M_KIB: u32 = 19_456;
const ARGON_T: u32 = 2;
const ARGON_P: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
/// DPAPI 信封的版本号（`qsEnc: 2`）
const DPAPI_VERSION: i64 = 2;

/// 这份内容的信封版本：`Some(1)` 密码信封、`Some(2)` DPAPI 信封、`None` 明文。
///
/// ⚠ 判断"是不是密文"必须只看这个，**不能**靠 `serde_json::from_str::<Config>`
/// 成功与否 —— `Config` 整份带 `#[serde(default)]`，密文信封也会"解析成功"
/// 但内容全默认（r92 踩过，那是"更新后设置归零"的真根因）。
pub fn envelope_version(text: &str) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get(MAGIC).and_then(|x| x.as_i64()) {
        Some(n @ (1 | DPAPI_VERSION)) => Some(n),
        _ => None,
    }
}

/// 内容是不是加密过的（两种信封都算）。
pub fn looks_encrypted(text: &str) -> bool {
    envelope_version(text).is_some()
}

/// 是不是 DPAPI 信封（不需要密码就能解）。
pub fn looks_dpapi(text: &str) -> bool {
    envelope_version(text) == Some(DPAPI_VERSION)
}

/* ══════════════════════════════════════════════════════════════════════
 * DPAPI 信封（v1.4.0）
 *
 * 用途只有两个，都很窄：
 *   ① 还没有备份密码时，本地配置也得有东西加密（不能落明文）；
 *   ② `backup.key`（备份密码的存档）本身不能明文躺盘上。
 *
 * 作用域是**当前 Windows 用户**（`CRYPTPROTECT_UI_FORBIDDEN`：不弹任何系统
 * 对话框）。也就是说：把整个数据文件夹拷到别的电脑/别的用户下解不开 ——
 * 这不是缺陷，是"本地数据加密"的应有之义；跨机搬数据走 WebDAV 加密备份
 * （那份是用备份密码加密的，能跨机）。
 * ══════════════════════════════════════════════════════════════════════ */
fn dpapi(protect: bool, data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
    };

    if data.is_empty() {
        return Err("没有要处理的数据".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let r = if protect {
            CryptProtectData(
                &input,
                windows::core::PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        // ⚠ 输出缓冲是系统分配的，**成败都要还**（失败时也可能是非空指针）
        let bytes = if out.pbData.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec()
        };
        if !out.pbData.is_null() {
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        }
        r.map_err(|e| {
            format!(
                "DPAPI {}失败（{e}）—— 换过 Windows 用户/机器，或文件被改过",
                if protect { "加密" } else { "解密" }
            )
        })?;
        Ok(bytes)
    }
}

/// 用 DPAPI 加密成信封。
pub fn encrypt_dpapi(plain: &str) -> Result<String, String> {
    let ct = dpapi(true, plain.as_bytes())?;
    Ok(serde_json::json!({
        MAGIC: DPAPI_VERSION,
        "alg": "dpapi",
        "data": b64_encode(&ct),
    })
    .to_string())
}

/// 解开 DPAPI 信封。
pub fn decrypt_dpapi(text: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("不是有效 JSON：{e}"))?;
    if v.get(MAGIC).and_then(|x| x.as_i64()) != Some(DPAPI_VERSION) {
        return Err("这不是 DPAPI 信封".into());
    }
    let data = base64_decode(v.get("data").and_then(|x| x.as_str()).unwrap_or(""));
    if data.is_empty() {
        return Err("信封里没有数据（文件可能被截断）".into());
    }
    let plain = dpapi(false, &data)?;
    String::from_utf8(plain).map_err(|_| "解密后的内容不是文本".to_string())
}

/// 本地数据的统一「封」：**有备份密码就用密码**（可跨机，用户选的口径），
/// 没有（首次运行还没设密码）就退回 DPAPI —— 无论如何不落明文。
pub fn seal(plain: &str, password: &str) -> Result<String, String> {
    if password.trim().is_empty() {
        encrypt_dpapi(plain)
    } else {
        encrypt(plain, password)
    }
}

/// 本地数据的统一「解」：按信封自己的版本号选钥匙，明文原样返回（老文件）。
pub fn unseal(text: &str, password: &str) -> Result<String, String> {
    match envelope_version(text) {
        Some(DPAPI_VERSION) => decrypt_dpapi(text),
        Some(_) => {
            if password.trim().is_empty() {
                return Err("这份数据是用备份密码加密的，但本机没有可用的密码".into());
            }
            decrypt(text, password)
        }
        None => Ok(text.to_string()),
    }
}


/// 用 Argon2id 把口令派生成 32 字节的 AES 密钥。盐每次加密随机生成。
///
/// `m_kib` / `t` / `p` 由调用方给 —— **解密时必须用文件里记下的那组值**，
/// 不能拿常量硬套：哪天调了默认参数，老备份就再也解不开了（而且报的还是
/// "密码不对"，用户只会以为密码记错了）。
fn derive_key(password: &str, salt: &[u8], m_kib: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
    use argon2::Algorithm::Argon2id;
    use argon2::Params;
    use argon2::Version::V0x13;

    let params = Params::new(m_kib, t, p, Some(32)).map_err(|e| format!("KDF 参数不对：{e}"))?;
    let a2 = argon2::Argon2::new(Argon2id, V0x13, params);
    let mut key = [0u8; 32];
    a2.hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("密钥派生失败：{e}"))?;
    Ok(key)
}

/// 「密码 → (盐, 密钥)」的进程内缓存。
///
/// ⚠ 为什么需要：`config::save` 每次改一个开关都会走到 `encrypt`，而 `derive_key`
///   是 Argon2id（19 MiB / t=2，这台机器实测 30~80ms）。于是设置页连点几个开关
///   就能明显感到发涩，而且这几十毫秒是**持着配置锁**花的（其他人要读配置就得等）。
///
///   盐的职责只是"让同一个密码在不同文件里的派生结果不同"，用来挡彩虹表；
///   同一台机器、同一个密码、反复写同一个文件时换盐**没有任何安全收益**
///   （每次的 nonce 都是新的，AES-GCM 那边该做的照做）。所以第一次派生之后
///   把盐和密钥留着复用：后续保存只剩 AES（微秒级）。
///
///   ⚠ 比对的是**密码原文**：用户一改密码立刻失效、重新派生 + 换盐，
///     绝不会拿旧密钥去加密新密码的内容。
///
/// （缓存条目 = (密码, 盐, 密钥)。抽成别名只是为了别让 clippy 把这一长串
///   类型当成"过于复杂"—— `type_complexity` 纯外观，不影响任何行为。）
type KeyCacheEntry = Option<(String, [u8; SALT_LEN], [u8; 32])>;
static KEY_CACHE: std::sync::OnceLock<std::sync::Mutex<KeyCacheEntry>> =
    std::sync::OnceLock::new();

/// 取（或派生并缓存）当前密码对应的盐与密钥。
fn cached_key(password: &str) -> Result<([u8; SALT_LEN], [u8; 32]), String> {
    let cell = KEY_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    let mut g = cell.lock().map_err(|_| "密钥缓存状态异常".to_string())?;
    if let Some((pw, salt, key)) = g.as_ref() {
        if pw == password {
            return Ok((*salt, *key));
        }
    }
    use rand::RngCore;
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(password, &salt, ARGON_M_KIB, ARGON_T, ARGON_P)?;
    *g = Some((password.to_string(), salt, key));
    Ok((salt, key))
}

/// 解密用的密钥缓存（按 密码 + 盐 + KDF 参数 索引）。
///
/// 启动时同一份 `config.json` 会被解密不止一次（主文件、失败后回退的备份、
/// 自动备份校验…），每次都要重跑 Argon2id —— 单次实测 ~120~150ms，
/// 三份就是接近半秒的启动白等。同一把钥匙解同一份文件，派生一次就够了。
///
/// ⚠ 缓存条目上限 8 个：正常只会用到一两个密码，超了直接清空重来，
///   免得"用户反复试密码"把内存撑大（也顺便让错误密码算出的密钥不至于长留）。
fn decrypt_key_cached(
    password: &str,
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
) -> Result<[u8; 32], String> {
    use std::collections::HashMap;
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, [u8; 32]>>> =
        std::sync::OnceLock::new();
    let cell = CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    // 键里带上盐和参数：换了盐/参数就是另一把钥匙，不能串
    let id = format!("{}|{}|{m}|{t}|{p}", password, b64_encode(salt));
    {
        let g = cell.lock().map_err(|_| "密钥缓存状态异常".to_string())?;
        if let Some(k) = g.get(&id) {
            return Ok(*k);
        }
    }
    let key = derive_key(password, salt, m, t, p)?;
    let mut g = cell.lock().map_err(|_| "密钥缓存状态异常".to_string())?;
    if g.len() >= 8 {
        g.clear();
    }
    g.insert(id, key);
    Ok(key)
}

/// 加密。返回一段**自带格式说明**的 JSON 字符串（可以直接当备份文件内容存）。
/// password 为空 = 不加密，原样返回。
pub fn encrypt(plain: &str, password: &str) -> Result<String, String> {
    /* ⚠ 空白密码**不能**静默降级成明文。
     *
     * 原来这里 `return Ok(plain)` 一声不响 —— 设置页允许只输空格，用户以为
     * "填了密码所以备份是加密的"，实际落盘的是明文（含 OCR Key、WebDAV 密码）。
     * 现在明确报错，让调用方（备份按钮）把提示弹给用户。
     * 真正"不要密码"的路径是传空串，那条路仍按旧行为原样返回。 */
    if password.is_empty() {
        return Ok(plain.to_string());
    }
    if password.trim().is_empty() {
        return Err("备份密码不能只有空格 —— 换个能真正加密的密码，或者清空密码改用不加密备份".into());
    }
    use rand::RngCore;
    // 盐复用（见 KEY_CACHE 的注释）：首次派生之后不再重复跑 Argon2
    let (salt, key) = cached_key(password)?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("初始化失败：{e}"))?;
    // 把版本号一并送进认证数据（AAD）：改版本 = 解不开，防降级攻击
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plain.as_bytes(),
                aad: format!("{MAGIC}=1").as_bytes(),
            },
        )
        .map_err(|_| "加密失败".to_string())?;

    /* ⚠ KDF 参数必须写进文件。
     *
     * 原来只有 `"kdf": "argon2id"`，m/t/p 全在常量里 —— 以后调参（或者不同
     * 版本默认值不一样）时，旧备份会**永久解不开**，而错误信息还写成"密码不对"，
     * 用户只会一遍遍重试密码。写进文件之后，解密按**文件自己的参数**派生。 */
    let doc = serde_json::json!({
        MAGIC: 1,
        "kdf": "argon2id",
        "m": ARGON_M_KIB,
        "t": ARGON_T,
        "p": ARGON_P,
        "salt": b64_encode(&salt),
        "nonce": b64_encode(&nonce),
        "data": b64_encode(&ct),
    });
    Ok(doc.to_string())
}

/// 解密。不是加密格式 → 原样返回（兼容旧备份）；口令不对 → 带人话的错误。
pub fn decrypt(text: &str, password: &str) -> Result<String, String> {
    if !looks_encrypted(text) {
        return Ok(text.to_string());
    }
    if password.trim().is_empty() {
        return Err("这份备份是加密的，但还没设置备份密码 —— 先在设置里填上再恢复".into());
    }
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("备份不是有效 JSON：{e}"))?;
    if v.get(MAGIC).and_then(|x| x.as_i64()).unwrap_or(0) != 1 {
        return Err("不认识的加密格式".into());
    }
    let unb = |s: &str| -> Result<Vec<u8>, String> {
        let out = base64_decode(s);
        if out.is_empty() {
            Err("备份里的 base64 解不开（文件可能被截断或改过）".into())
        } else {
            Ok(out)
        }
    };
    let salt = unb(v.get("salt").and_then(|x| x.as_str()).unwrap_or(""))?;
    let nonce = unb(v.get("nonce").and_then(|x| x.as_str()).unwrap_or(""))?;
    let data = unb(v.get("data").and_then(|x| x.as_str()).unwrap_or(""))?;
    if salt.len() != SALT_LEN || nonce.len() != NONCE_LEN {
        return Err("备份的加密参数不对（文件可能被改过）".into());
    }

    /* 按**文件里记下的** KDF 参数派生。
     * 老备份（没有 m/t/p 三个键）→ 回落到当前默认值，行为和升级前完全一致。 */
    let m = v.get("m").and_then(|x| x.as_u64()).unwrap_or(ARGON_M_KIB as u64) as u32;
    let t = v.get("t").and_then(|x| x.as_u64()).unwrap_or(ARGON_T as u64) as u32;
    let p = v.get("p").and_then(|x| x.as_u64()).unwrap_or(ARGON_P as u64) as u32;
    // 防呆：手改过的文件可能给出荒谬参数（内存 16GiB / 迭代 100 万次 → 卡死）
    if !(8_192..=1_048_576).contains(&m) || !(1..=16).contains(&t) || !(1..=16).contains(&p) {
        return Err("备份里的 KDF 参数不合理（文件可能被改过）".into());
    }
    let key = decrypt_key_cached(password, &salt, m, t, p)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("初始化失败：{e}"))?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &data,
                aad: format!("{MAGIC}=1").as_bytes(),
            },
        )
        .map_err(|_| {
            "解密失败 —— 备份密码不对（或这份备份不是用这个密码加密的）".to_string()
        })?;
    String::from_utf8(plain).map_err(|_| "解密后的内容不是文本".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_wrong_password() {
        let s = r#"{"version":"1","barList":["百度"]}"#;
        let enc = encrypt(s, "口令123").unwrap();
        assert!(looks_encrypted(&enc));
        assert!(!enc.contains("百度"), "密文里不许出现原文");
        assert_eq!(decrypt(&enc, "口令123").unwrap(), s);
        assert!(decrypt(&enc, "错误的密码").is_err());
    }

    #[test]
    fn empty_password_is_passthrough() {
        let s = "hello";
        assert_eq!(encrypt(s, "").unwrap(), s);
        assert!(!looks_encrypted(s));
        assert_eq!(decrypt(s, "").unwrap(), s);
    }

    /// v1.4.0：DPAPI 信封（不需要密码那条路）—— 磁盘上永远没有明文。
    #[test]
    fn dpapi_envelope_round_trip() {
        let s = r#"{"backup_password":"秘密","ocr_key":"AKID123"}"#;
        let enc = encrypt_dpapi(s).expect("DPAPI 加密失败（测试机上应可用）");
        assert!(looks_dpapi(&enc), "应当被识别成 DPAPI 信封");
        assert!(looks_encrypted(&enc), "DPAPI 信封也算密文");
        assert!(!enc.contains("秘密"), "密文里不许出现原文");
        assert!(!enc.contains("AKID123"));
        assert_eq!(decrypt_dpapi(&enc).unwrap(), s);
        // 用密码去解 DPAPI 信封 → 明确报错，而不是"解出一堆乱码"
        assert!(decrypt(&enc, "随便").is_err() || decrypt(&enc, "随便").unwrap() != s);
    }

    /// `seal` / `unseal`：有密码走密码，没密码走 DPAPI；明文原样放行。
    #[test]
    fn seal_unseal_picks_the_right_key() {
        let s = r#"{"a":1}"#;
        // 有密码 → 密码信封（可跨机）
        let with_pw = seal(s, "pw").unwrap();
        assert_eq!(envelope_version(&with_pw), Some(1));
        assert_eq!(unseal(&with_pw, "pw").unwrap(), s);
        assert!(unseal(&with_pw, "").is_err(), "没密码就该报错，不能静默");
        // 没密码 → DPAPI 信封
        let no_pw = seal(s, "").unwrap();
        assert_eq!(envelope_version(&no_pw), Some(2));
        assert_eq!(unseal(&no_pw, "").unwrap(), s);
        // 明文（老文件）原样放行
        assert_eq!(unseal(s, "").unwrap(), s);
        assert_eq!(envelope_version(s), None);
    }

    #[test]
    fn legacy_plaintext_backup_still_restores() {
        // 旧备份是明文 —— 恢复时必须原样放行，不能因为"没密码"而报错
        let s = r#"{"version":"1"}"#;
        assert_eq!(decrypt(s, "任意密码").unwrap(), s);
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let enc = encrypt("{\"version\":\"1\"}", "pw").unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&enc).unwrap();
        let mut data = base64_decode(v["data"].as_str().unwrap());
        data[0] ^= 0xFF;
        v["data"] = serde_json::Value::String(b64_encode(&data));
        assert!(decrypt(&v.to_string(), "pw").is_err());
    }

    /// 盐在**同一进程、同一密码**下复用（省掉每次保存的 Argon2），
    /// 但 nonce 必须每条都新 —— 这才是 AES-GCM 的安全底线。
    ///
    /// ⚠ 这条测试原来叫 `salt_is_random_per_call`，断言"两次加密的盐/nonce 都不同"。
    ///   v1.4.2 起改成复用盐 + 换 nonce：盐的作用只是挡彩虹表，同一个密码反复写
    ///   同一个文件时换盐没有安全收益，而 Argon2id（19MiB/t=2，30~80ms）每次保存
    ///   都跑一遍会让设置页发涩 —— 见 KEY_CACHE 的注释。
    #[test]
    fn salt_is_reused_but_nonce_is_fresh() {
        let a = encrypt("x", "pw").unwrap();
        let b = encrypt("x", "pw").unwrap();
        assert_ne!(a, b, "密文必须不同（nonce 每条都是新的）");
        let va: serde_json::Value = serde_json::from_str(&a).unwrap();
        let vb: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(va["salt"], vb["salt"], "同一密码的盐应复用（省一次 Argon2）");
        assert_ne!(va["nonce"], vb["nonce"], "nonce 绝不能重复");
        assert_eq!(decrypt(&a, "pw").unwrap(), "x");
        assert_eq!(decrypt(&b, "pw").unwrap(), "x");
    }

    /// 换密码必须立刻换盐换密钥：旧密文用新密码解不开，新密文用新密码才解得开。
    #[test]
    fn changing_password_invalidates_the_cached_key() {
        let a = encrypt("secret", "old-pw").unwrap();
        let c = encrypt("secret", "new-pw").unwrap();
        let va: serde_json::Value = serde_json::from_str(&a).unwrap();
        let vc: serde_json::Value = serde_json::from_str(&c).unwrap();
        assert_ne!(va["salt"], vc["salt"], "换密码必须换盐");
        assert!(decrypt(&a, "new-pw").is_err(), "旧密文不能用新密码解开");
        assert_eq!(decrypt(&c, "new-pw").unwrap(), "secret");
        assert_eq!(decrypt(&a, "old-pw").unwrap(), "secret");
    }
}
