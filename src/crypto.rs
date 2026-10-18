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
//! 备份文件形态（人可读的 JSON，坏不了）：
//! ```json
//! { "qsEnc": 1, "kdf": "argon2id", "salt": "...", "nonce": "...", "data": "..." }
//! ```

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

/// 备份内容是不是加密过的（恢复时用它决定要不要先解密）。
pub fn looks_encrypted(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .map(|v| v.get(MAGIC).and_then(|x| x.as_i64()).unwrap_or(0) == 1)
        .unwrap_or(false)
}

/// 用 Argon2id 把口令派生成 32 字节的 AES 密钥。盐每次加密随机生成。
fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    use argon2::Algorithm::Argon2id;
    use argon2::Params;
    use argon2::Version::V0x13;

    let params = Params::new(ARGON_M_KIB, ARGON_T, ARGON_P, Some(32))
        .map_err(|e| format!("KDF 参数不对：{e}"))?;
    let a2 = argon2::Argon2::new(Argon2id, V0x13, params);
    let mut key = [0u8; 32];
    a2.hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("密钥派生失败：{e}"))?;
    Ok(key)
}

/// 加密。返回一段**自带格式说明**的 JSON 字符串（可以直接当备份文件内容存）。
/// password 为空 = 不加密，原样返回。
pub fn encrypt(plain: &str, password: &str) -> Result<String, String> {
    if password.trim().is_empty() {
        return Ok(plain.to_string());
    }
    use rand::RngCore;
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);

    let key = derive_key(password, &salt)?;
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

    let doc = serde_json::json!({
        MAGIC: 1,
        "kdf": "argon2id",
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

    let key = derive_key(password, &salt)?;
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

    #[test]
    fn salt_is_random_per_call() {
        let a = encrypt("x", "pw").unwrap();
        let b = encrypt("x", "pw").unwrap();
        assert_ne!(a, b, "同一内容两次加密的盐/nonce 必须不同");
    }
}
