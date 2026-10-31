//! 替代 `#[tauri::command]` / `generate_handler!` 的垫层宏。
//!
//! 原项目的 152 个命令签名只有一种特殊参数（`AppHandle`），其余都是普通 serde
//! 可反序列化类型，所以这里不需要做复杂的类型推导：
//!
//! - `AppHandle`  → 从上下文取
//! - 其它任何类型 → 从 JSON 里按「驼峰优先、下划线兜底」取名后反序列化
//!
//! 生成的 invoker 统一签名：
//! `fn(&Ctx, &serde_json::Value) -> Result<serde_json::Value, String>`

use proc_macro::TokenStream;
use proc_macro2::Span;
use quote::{format_ident, quote};
use syn::{
    parse_macro_input, punctuated::Punctuated, FnArg, ItemFn, Pat, Path, ReturnType, Token, Type,
};

fn is_app_handle(ty: &Type) -> bool {
    if let Type::Path(tp) = ty {
        if let Some(last) = tp.path.segments.last() {
            return last.ident == "AppHandle";
        }
    }
    false
}

/// 返回值是不是 `Result<_, _>`
fn is_result(rt: &ReturnType) -> bool {
    if let ReturnType::Type(_, ty) = rt {
        if let Type::Path(tp) = &**ty {
            if let Some(last) = tp.path.segments.last() {
                return last.ident == "Result";
            }
        }
    }
    false
}

fn to_camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut up = false;
    for ch in s.chars() {
        if ch == '_' {
            up = true;
        } else if up {
            out.extend(ch.to_uppercase());
            up = false;
        } else {
            out.push(ch);
        }
    }
    out
}

#[proc_macro_attribute]
pub fn command(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let f = parse_macro_input!(item as ItemFn);
    let name = &f.sig.ident;
    let inv = format_ident!("__qs_invoke_{}", name);
    let is_async = f.sig.asyncness.is_some();

    let mut prelude = Vec::new();
    let mut ids = Vec::new();

    for arg in &f.sig.inputs {
        let FnArg::Typed(pt) = arg else { continue };
        let Pat::Ident(pi) = &*pt.pat else { continue };
        let ident = &pi.ident;
        let key = ident.to_string();
        let ty = &pt.ty;
        ids.push(ident.clone());
        if is_app_handle(ty) {
            prelude.push(quote! {
                let #ident: #ty = __ctx.app().clone();
            });
        } else {
            let camel = to_camel(&key);
            prelude.push(quote! {
                let #ident: #ty = crate::t::arg(__args, #camel, #key)?;
            });
        }
    }

    let call = if is_async {
        quote! { crate::t::block_on(#name(#(#ids),*)) }
    } else {
        quote! { #name(#(#ids),*) }
    };

    let ret = if is_result(&f.sig.output) {
        quote! {
            match #call {
                Ok(v) => Ok(crate::t::to_value(v)),
                Err(e) => Err(::std::string::ToString::to_string(&e)),
            }
        }
    } else if matches!(&f.sig.output, ReturnType::Default) {
        quote! {
            #call;
            Ok(serde_json::Value::Null)
        }
    } else {
        quote! { Ok(crate::t::to_value(#call)) }
    };

    let _ = Span::call_site();
    let reg = format_ident!("__qs_reg_{}", name);
    let name_str = name.to_string();
    let out = quote! {
        #f

        #[allow(non_snake_case, unused_variables)]
        pub fn #inv(
            __ctx: &crate::t::Ctx,
            __args: &serde_json::Value,
        ) -> ::std::result::Result<serde_json::Value, String> {
            #(#prelude)*
            #ret
        }

        #[allow(non_snake_case)]
        pub fn #reg() -> (&'static str, crate::t::Invoker) {
            (#name_str, #inv as crate::t::Invoker)
        }
    };
    out.into()
}

#[proc_macro]
pub fn generate_handler(input: TokenStream) -> TokenStream {
    let paths = parse_macro_input!(input with Punctuated::<Path, Token![,]>::parse_terminated);
    let regs: Vec<_> = paths
        .iter()
        .filter_map(|p| p.segments.last())
        .map(|seg| format_ident!("__qs_reg_{}", seg.ident))
        .collect();
    quote! { vec![#(#regs()),*] }.into()
}
