use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::redirect::Policy as RedirectPolicy;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::http::{Request, Response, StatusCode};
use tauri::Manager;
use tokio::fs;
use tokio::net::lookup_host;
use tokio::task::JoinSet;

use crate::ai::security::network_permission::validate_public_http_url;

const CACHE_DIR_NAME: &str = "favicons";
const CACHE_TTL_SUCCESS_SECS: i64 = 30 * 24 * 60 * 60;
const CACHE_TTL_FAILED_SECS: i64 = 24 * 60 * 60;
const REQUEST_TIMEOUT_SECS: u64 = 3;
const MAX_ICON_BYTES: usize = 256 * 1024;
const MAX_HTML_BYTES: usize = 128 * 1024;
const MAX_REDIRECTS: usize = 5;
const USER_AGENT: &str = "Calamex-Favicon-Proxy/0.2";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FaviconCacheMeta {
    status: String,
    expires_at: i64,
    content_type: Option<String>,
}

#[derive(Debug)]
enum CacheLookup {
    Hit {
        bytes: Vec<u8>,
        content_type: String,
    },
    Negative,
    Miss,
}

pub async fn handle_protocol_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let Some(host) = parse_favicon_host(&request) else {
        return text_response(StatusCode::BAD_REQUEST, "invalid favicon host");
    };

    let cache_root = match resolve_cache_root(app) {
        Ok(path) => path,
        Err(_) => {
            return text_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to resolve favicon cache path",
            );
        }
    };

    match read_cache_entry(&cache_root, &host).await {
        CacheLookup::Hit {
            bytes,
            content_type,
        } => {
            return binary_response(StatusCode::OK, &content_type, bytes, true);
        }
        CacheLookup::Negative => {
            return not_found_response();
        }
        CacheLookup::Miss => {}
    }

    match fetch_favicon_bytes(&host).await {
        Ok((bytes, content_type)) => {
            let _ = write_success_cache_entry(&cache_root, &host, &bytes, &content_type).await;
            binary_response(StatusCode::OK, &content_type, bytes, true)
        }
        Err(_) => {
            let _ = write_failure_cache_entry(&cache_root, &host).await;
            not_found_response()
        }
    }
}

// ─── host parsing ───────────────────────────────────────────────────────────

fn parse_favicon_host(request: &Request<Vec<u8>>) -> Option<String> {
    let authority = request
        .uri()
        .authority()
        .map(|value| value.as_str())
        .unwrap_or_default();
    if !authority.is_empty()
        && !authority.eq_ignore_ascii_case("localhost")
        && !authority.eq_ignore_ascii_case("favicon.localhost")
    {
        return None;
    }

    let raw_host = request.uri().path().trim_matches('/').trim().to_lowercase();
    if raw_host.is_empty() || raw_host.len() > 253 {
        return None;
    }
    if raw_host.contains('/') || raw_host.contains(':') {
        return None;
    }
    if !raw_host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return None;
    }
    // 拒绝前导/尾随点、连续点、空标签、单纯 IP 文本
    if raw_host.starts_with('.') || raw_host.ends_with('.') {
        return None;
    }
    if raw_host.split('.').any(|label| label.is_empty()) {
        return None;
    }
    if raw_host.parse::<IpAddr>().is_ok() {
        return None;
    }
    Some(raw_host)
}

// ─── cache layout (兼容旧版命名) ────────────────────────────────────────────

fn resolve_cache_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    Ok(base_dir.join(CACHE_DIR_NAME))
}

fn cache_file_stem(host: &str) -> String {
    host.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn cache_meta_path(cache_root: &Path, host: &str) -> PathBuf {
    cache_root.join(format!("{}.json", cache_file_stem(host)))
}

fn cache_icon_path(cache_root: &Path, host: &str) -> PathBuf {
    cache_root.join(format!("{}.bin", cache_file_stem(host)))
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

async fn ensure_cache_dir(cache_root: &Path) -> Result<(), String> {
    fs::create_dir_all(cache_root)
        .await
        .map_err(|error| format!("failed to create favicon cache dir: {error}"))
}

async fn read_cache_entry(cache_root: &Path, host: &str) -> CacheLookup {
    let meta_path = cache_meta_path(cache_root, host);
    let icon_path = cache_icon_path(cache_root, host);

    let raw_meta = match fs::read(&meta_path).await {
        Ok(content) => content,
        Err(_) => return CacheLookup::Miss,
    };
    let meta: FaviconCacheMeta = match serde_json::from_slice(&raw_meta) {
        Ok(value) => value,
        Err(_) => return CacheLookup::Miss,
    };

    if meta.expires_at <= now_unix_secs() {
        let _ = fs::remove_file(&meta_path).await;
        let _ = fs::remove_file(&icon_path).await;
        return CacheLookup::Miss;
    }
    if meta.status == "failed" {
        return CacheLookup::Negative;
    }

    let bytes = match fs::read(&icon_path).await {
        Ok(content) => content,
        Err(_) => return CacheLookup::Miss,
    };
    let content_type = meta
        .content_type
        .unwrap_or_else(|| "image/x-icon".to_string());

    CacheLookup::Hit {
        bytes,
        content_type,
    }
}

async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("part")
    ));
    fs::write(&tmp, bytes)
        .await
        .map_err(|e| format!("write tmp failed: {e}"))?;
    fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
}

async fn write_success_cache_entry(
    cache_root: &Path,
    host: &str,
    bytes: &[u8],
    content_type: &str,
) -> Result<(), String> {
    ensure_cache_dir(cache_root).await?;

    let meta = FaviconCacheMeta {
        status: "ok".to_string(),
        expires_at: now_unix_secs() + CACHE_TTL_SUCCESS_SECS,
        content_type: Some(content_type.to_string()),
    };
    let icon_path = cache_icon_path(cache_root, host);
    let meta_path = cache_meta_path(cache_root, host);

    atomic_write(&icon_path, bytes).await?;
    let meta_bytes = serde_json::to_vec(&meta)
        .map_err(|error| format!("failed to encode favicon cache meta: {error}"))?;
    atomic_write(&meta_path, &meta_bytes).await?;
    Ok(())
}

async fn write_failure_cache_entry(cache_root: &Path, host: &str) -> Result<(), String> {
    ensure_cache_dir(cache_root).await?;
    let icon_path = cache_icon_path(cache_root, host);
    let meta_path = cache_meta_path(cache_root, host);

    let meta = FaviconCacheMeta {
        status: "failed".to_string(),
        expires_at: now_unix_secs() + CACHE_TTL_FAILED_SECS,
        content_type: None,
    };
    let meta_bytes = serde_json::to_vec(&meta)
        .map_err(|error| format!("failed to encode favicon negative cache meta: {error}"))?;

    let _ = fs::remove_file(&icon_path).await;
    atomic_write(&meta_path, &meta_bytes).await?;
    Ok(())
}

// ─── fetch pipeline ─────────────────────────────────────────────────────────

async fn fetch_favicon_bytes(host: &str) -> Result<(Vec<u8>, String), String> {
    let mut primary_candidates: Vec<String> = Vec::with_capacity(6);
    primary_candidates.push(format!("https://{host}/favicon.ico"));
    primary_candidates.push(format!("https://favicon.im/{host}?larger=true"));
    primary_candidates.push(format!("https://manifest.im/icon/{host}"));
    primary_candidates.push(format!("https://favicon.id/{host}?t=l"));
    primary_candidates.push(format!("https://favicon.so/{host}"));
    if let Some(slug) = simple_icon_slug_for_host(host) {
        primary_candidates.push(format!("https://cdn.simpleicons.org/{slug}"));
    }

    if let Ok(pair) = fetch_first_available_icon(primary_candidates).await {
        return Ok(pair);
    }

    if let Some(icon_url) = resolve_html_icon_url(host).await
        && let Ok(pair) = try_fetch_icon(icon_url.as_str()).await {
            return Ok(pair);
        }

    Err("favicon not found".to_string())
}

async fn fetch_first_available_icon(candidates: Vec<String>) -> Result<(Vec<u8>, String), String> {
    let mut tasks = JoinSet::new();

    for candidate in candidates {
        tasks.spawn(async move { try_fetch_icon(&candidate).await });
    }

    while let Some(result) = tasks.join_next().await {
        if let Ok(Ok(pair)) = result {
            tasks.abort_all();
            return Ok(pair);
        }
    }

    Err("favicon not found".to_string())
}

async fn resolve_html_icon_url(host: &str) -> Option<Url> {
    let base = Url::parse(&format!("https://{host}/")).ok()?;

    // 解析并钉死 DNS
    let pinned = resolve_and_validate(&base).await.ok()?;
    let client = build_pinned_client(&pinned).ok()?;

    let response = client
        .get(base.clone())
        .header(ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    let bytes = read_capped_bytes(response, MAX_HTML_BYTES).await.ok()?;
    let body = String::from_utf8_lossy(&bytes);
    let href = find_html_icon_href(&body)?;
    base.join(&href).ok()
}

async fn try_fetch_icon(candidate_url: &str) -> Result<(Vec<u8>, String), String> {
    let url = validate_public_http_url(candidate_url)?;
    let pinned = resolve_and_validate(&url).await?;
    let client = build_pinned_client(&pinned)?;

    let response = client
        .get(url)
        .header(ACCEPT, "image/*,*/*;q=0.8")
        .send()
        .await
        .map_err(|error| format!("favicon fetch request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("favicon fetch status is {}", response.status()));
    }

    // 提前用 Content-Length 拒绝过大响应（如有）
    if let Some(content_length) = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        && content_length > MAX_ICON_BYTES {
            return Err("favicon payload exceeds content-length limit".into());
        }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/x-icon")
        .to_string();

    let bytes = read_capped_bytes(response, MAX_ICON_BYTES).await?;
    if bytes.is_empty() {
        return Err("empty favicon payload".into());
    }

    let detected_content_type = detect_image_content_type(&content_type, &bytes);

    if detected_content_type.is_none() {
        return Err(format!("not an image (content-type={content_type})"));
    }

    Ok((
        bytes,
        detected_content_type.unwrap_or_else(|| "image/x-icon".to_string()),
    ))
}

async fn read_capped_bytes(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > max_bytes {
                    return Err("payload exceeds limit".into());
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(error) => return Err(format!("failed to read body chunk: {error}")),
        }
    }
    Ok(buf)
}

fn sanitize_content_type(raw: &str) -> String {
    // 仅保留 type/subtype，去掉 charset 等参数
    raw.split(';')
        .next()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "image/x-icon".to_string())
}

fn detect_image_content_type(content_type: &str, bytes: &[u8]) -> Option<String> {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("image/") {
        return Some(sanitize_content_type(content_type));
    }
    // 一些站点会返回 application/octet-stream / 错误 text/html，靠魔数兜底
    if bytes.len() >= 8 && &bytes[0..4] == b"\x89PNG" {
        return Some("image/png".to_string());
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"\x00\x00\x01\x00" {
        return Some("image/x-icon".to_string());
    }
    if bytes.len() >= 6 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        return Some("image/gif".to_string());
    }
    if bytes.len() >= 3 && &bytes[0..3] == b"\xff\xd8\xff" {
        return Some("image/jpeg".to_string());
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp".to_string());
    }
    let head = &bytes[..bytes.len().min(512)];
    if let Ok(text) = std::str::from_utf8(head) {
        let trimmed = text.trim_start();
        if trimmed.starts_with("<svg") || trimmed.starts_with("<?xml") {
            return Some("image/svg+xml".to_string());
        }
    }
    None
}

fn simple_icon_slug_for_host(host: &str) -> Option<&'static str> {
    let normalized = host.trim().trim_start_matches("www.");

    match normalized {
        "github.com" => Some("github"),
        "youtube.com" | "youtu.be" => Some("youtube"),
        "zhihu.com" => Some("zhihu"),
        "weibo.com" => Some("sinaweibo"),
        "douban.com" => Some("douban"),
        "qq.com" => Some("tencentqq"),
        "x.com" | "twitter.com" => Some("x"),
        "npmjs.com" => Some("npm"),
        "nodejs.org" => Some("nodedotjs"),
        "rust-lang.org" => Some("rust"),
        "vuejs.org" => Some("vuedotjs"),
        "vitejs.dev" => Some("vite"),
        "tauri.app" => Some("tauri"),
        "stackoverflow.com" => Some("stackoverflow"),
        "medium.com" => Some("medium"),
        "reddit.com" => Some("reddit"),
        "wikipedia.org" => Some("wikipedia"),
        _ => None,
    }
}

// ─── HTML <link rel="icon"> 解析 (词边界 + sizes 选最大) ─────────────────────

#[derive(Default)]
struct IconCandidate {
    sizes: u32,
    href: String,
}

fn find_html_icon_href(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut best: Option<IconCandidate> = None;
    let mut search_index = 0usize;

    while let Some(link_index) = lower[search_index..].find("<link") {
        let start = search_index + link_index;
        let after = start + 5;
        // 确认 "<link" 是一个完整标签开头（后随空白/'>'/'/）
        let next_byte = lower.as_bytes().get(after).copied().unwrap_or(b' ');
        let is_tag_start = matches!(next_byte, b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/');
        if !is_tag_start {
            search_index = start + 5;
            continue;
        }

        let end = match lower[start..].find('>').map(|offset| start + offset) {
            Some(value) => value,
            None => break,
        };
        let tag = &html[start..=end];
        let tag_lower = &lower[start..=end];

        if let Some(rel_value) = extract_html_attribute(tag, tag_lower, "rel") {
            let rel_lower = rel_value.to_ascii_lowercase();
            let is_icon = rel_lower.split(|c: char| c.is_whitespace()).any(|tok| {
                matches!(
                    tok,
                    "icon" | "shortcut" | "apple-touch-icon" | "mask-icon" | "fluid-icon"
                )
            });
            if is_icon
                && let Some(href) = extract_html_attribute(tag, tag_lower, "href") {
                    let href_trim = href.trim().to_string();
                    if !href_trim.is_empty() {
                        let size = extract_html_attribute(tag, tag_lower, "sizes")
                            .and_then(|s| {
                                s.split(['x', 'X'])
                                    .next()
                                    .map(|x| x.trim().to_string())
                            })
                            .and_then(|s| s.parse::<u32>().ok())
                            .unwrap_or(16);
                        if best.as_ref().map(|b| size > b.sizes).unwrap_or(true) {
                            best = Some(IconCandidate {
                                sizes: size,
                                href: href_trim,
                            });
                        }
                    }
                }
        }

        search_index = end + 1;
    }

    best.map(|c| c.href)
}

fn extract_html_attribute(tag: &str, tag_lower: &str, attribute: &str) -> Option<String> {
    let key = format!("{attribute}=");
    let mut from = 0usize;

    loop {
        let rel_offset = tag_lower[from..].find(&key)?;
        let key_pos = from + rel_offset;

        // 词边界：前一个字符必须是空白、'<' 或 '/'
        let boundary_ok = if key_pos == 0 {
            true
        } else {
            let b = tag_lower.as_bytes()[key_pos - 1];
            matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'<' | b'/')
        };
        if !boundary_ok {
            from = key_pos + key.len();
            continue;
        }

        let value_start = key_pos + key.len();
        let rest = &tag[value_start..];
        let trimmed = rest.trim_start();

        if let Some(stripped) = trimmed.strip_prefix('"') {
            let end = stripped.find('"')?;
            return Some(stripped[..end].to_string());
        }
        if let Some(stripped) = trimmed.strip_prefix('\'') {
            let end = stripped.find('\'')?;
            return Some(stripped[..end].to_string());
        }
        let end = trimmed
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(trimmed.len());
        return Some(trimmed[..end].to_string());
    }
}

// ─── DNS 解析 + SSRF + DNS pinning ─────────────────────────────────────────

#[derive(Debug)]
struct PinnedTarget {
    host: String,
    addrs: Vec<SocketAddr>,
}

async fn resolve_and_validate(url: &Url) -> Result<PinnedTarget, String> {
    if url.scheme() != "https" {
        return Err("favicon URL must be https".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "favicon URL missing host".to_string())?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);

    // IP 字面量
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err("favicon host resolves to blocked IP".into());
        }
        return Ok(PinnedTarget {
            host,
            addrs: vec![SocketAddr::new(ip, port)],
        });
    }

    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return Err("localhost is blocked for favicon proxy".into());
    }

    let mut addrs: Vec<SocketAddr> = Vec::new();
    let resolved = lookup_host((host.as_str(), port))
        .await
        .map_err(|error| format!("failed to resolve favicon host: {error}"))?;
    for sa in resolved {
        if is_blocked_ip(sa.ip()) {
            return Err("favicon host resolved to blocked IP".into());
        }
        addrs.push(sa);
    }
    if addrs.is_empty() {
        return Err("favicon host did not resolve to public addresses".into());
    }
    Ok(PinnedTarget { host, addrs })
}

fn build_pinned_client(target: &PinnedTarget) -> Result<reqwest::Client, String> {
    let addrs: Vec<SocketAddr> = target.addrs.clone();

    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(build_redirect_policy())
        .user_agent(USER_AGENT)
        .resolve_to_addrs(&target.host, &addrs)
        .build()
        .map_err(|error| format!("failed to build favicon http client: {error}"))
}

fn build_redirect_policy() -> RedirectPolicy {
    RedirectPolicy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        let url = attempt.url();
        if url.scheme() != "https" {
            return attempt.error("redirect to non-https");
        }
        if let Some(host) = url.host_str() {
            // IP 字面量重定向：直接用同样的 SSRF 规则同步检查
            if let Ok(ip) = host.parse::<IpAddr>()
                && is_blocked_ip(ip) {
                    return attempt.error("redirect target is a blocked IP");
                }
            if host.eq_ignore_ascii_case("localhost")
                || host.to_ascii_lowercase().ends_with(".localhost")
            {
                return attempt.error("redirect target is localhost");
            }
        } else {
            return attempt.error("redirect target missing host");
        }
        attempt.follow()
    })
}

// ─── IP allow/deny ─────────────────────────────────────────────────────────

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => is_blocked_ipv4(v),
        IpAddr::V6(v) => is_blocked_ipv6(v),
    }
}

fn is_blocked_ipv4(v: Ipv4Addr) -> bool {
    let o = v.octets();
    v.is_private()
        || v.is_loopback()
        || v.is_link_local()
        || v.is_broadcast()
        || v.is_documentation()
        || v.is_multicast()
        || v.is_unspecified()
        || o[0] == 0
        || o[0] >= 240                                  // 240/4 reserved
        || (o[0] == 100 && (o[1] & 0xc0) == 64)         // 100.64/10 CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)      // 192.0.0/24 IETF
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // 198.18/15 benchmark
}

fn is_blocked_ipv6(v: Ipv6Addr) -> bool {
    // IPv4-mapped (::ffff:a.b.c.d) — 复用 v4 规则
    if let Some(v4) = v.to_ipv4_mapped() {
        return is_blocked_ipv4(v4);
    }
    let s = v.segments();

    // 6to4 (2002::/16) 包裹一个 v4，校验内嵌 v4
    if s[0] == 0x2002 {
        let v4 = Ipv4Addr::new(
            (s[1] >> 8) as u8,
            (s[1] & 0xff) as u8,
            (s[2] >> 8) as u8,
            (s[2] & 0xff) as u8,
        );
        if is_blocked_ipv4(v4) {
            return true;
        }
    }

    v.is_loopback()
        || v.is_unspecified()
        || v.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00            // ULA fc00::/7
        || (s[0] & 0xffc0) == 0xfe80            // link-local fe80::/10
        || (s[0] == 0x2001 && s[1] == 0x0db8) // 2001:db8::/32 documentation
}

// ─── responses ─────────────────────────────────────────────────────────────

fn text_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn not_found_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain; charset=utf-8")
        // 让前端短期内不要狂打：1 天内复用负缓存
        .header("Cache-Control", "public, max-age=86400")
        .body(b"favicon not found".to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn binary_response(
    status: StatusCode,
    content_type: &str,
    bytes: Vec<u8>,
    long_cache: bool,
) -> Response<Vec<u8>> {
    let cache_control = if long_cache {
        "public, max-age=2592000, immutable"
    } else {
        "no-store"
    };
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", cache_control)
        .body(bytes)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(uri: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(uri)
            .body(Vec::new())
            .expect("test favicon request should be valid")
    }

    #[test]
    fn parse_favicon_host_accepts_custom_scheme_host() {
        let request = request("favicon://localhost/github.com");

        assert_eq!(parse_favicon_host(&request).as_deref(), Some("github.com"));
    }

    #[test]
    fn parse_favicon_host_accepts_webview_localhost_alias() {
        let request = request("http://favicon.localhost/github.com");

        assert_eq!(parse_favicon_host(&request).as_deref(), Some("github.com"));
    }

    #[test]
    fn parse_favicon_host_rejects_unexpected_authority() {
        let request = request("http://example.com/github.com");

        assert_eq!(parse_favicon_host(&request), None);
    }

    #[test]
    fn detects_svg_from_plain_text_response() {
        let bytes = br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>"#;

        assert_eq!(
            detect_image_content_type("text/plain; charset=utf-8", bytes).as_deref(),
            Some("image/svg+xml")
        );
    }

    #[test]
    fn maps_common_hosts_to_simple_icons_slugs() {
        assert_eq!(simple_icon_slug_for_host("github.com"), Some("github"));
        assert_eq!(simple_icon_slug_for_host("www.zhihu.com"), Some("zhihu"));
        assert_eq!(simple_icon_slug_for_host("weibo.com"), Some("sinaweibo"));
    }
}
