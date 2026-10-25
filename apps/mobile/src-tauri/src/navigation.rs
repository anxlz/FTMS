//! Where the app's web view may go (Phase 8): its bundled launcher page and the
//! configured FTMS web app — nothing else. Pages of the web app are also the only
//! remote pages allowed to call native plugins (capabilities/remote.json).

use serde::Deserialize;
use url::Url;

/// `src/config.json`, written by `scripts/configure.mjs` from `FTMS_WEB_URL`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub web_url: String,
    #[serde(default)]
    pub placeholder: bool,
}

/// The configured web app origin, or an error for a malformed or non-HTTP(S) address.
pub fn web_origin(config_json: &str) -> Result<Url, String> {
    let config: AppConfig =
        serde_json::from_str(config_json).map_err(|e| format!("invalid src/config.json: {e}"))?;
    if config.placeholder && !cfg!(debug_assertions) {
        return Err("src/config.json holds the compile-check placeholder; run `pnpm configure` with FTMS_WEB_URL before a release build".into());
    }
    let url = Url::parse(&config.web_url).map_err(|e| format!("invalid webUrl: {e}"))?;
    match url.scheme() {
        "https" => {}
        "http" if is_dev_host(&url) => {}
        _ => return Err("webUrl must use https (http only for local development)".into()),
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("webUrl must be a plain origin".into());
    }
    Ok(url)
}

fn is_dev_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "10.0.2.2"))
}

/// The page bundled with the app (served by Tauri on Android at `http(s)://tauri.localhost`).
fn is_launcher(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Whether the main web view may load `url`.
pub fn allowed(url: &Url, web: &Url) -> bool {
    is_launcher(url) || same_origin(url, web)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web() -> Url {
        web_origin(r#"{"webUrl":"https://ftms.example.edu","placeholder":false}"#).unwrap()
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_the_launcher_and_the_web_app_only() {
        let web = web();
        for ok in [
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "tauri://localhost/index.html",
            "https://ftms.example.edu/",
            "https://ftms.example.edu/check-in/abc/guest",
            "https://ftms.example.edu:443/login?next=%2Fdashboard",
        ] {
            assert!(allowed(&url(ok), &web), "{ok}");
        }
        for blocked in [
            "http://ftms.example.edu/",
            "https://ftms.example.edu.evil.example/",
            "https://evil.example/?https://ftms.example.edu",
            "https://ftms.example.edu:8443/",
            "https://www.google.com/maps?q=30,31",
            "http://evil.localhost/",
            "file:///data/data/eg.edu.asu.agr.ftms/",
            "javascript:alert(1)",
            "data:text/html,hi",
        ] {
            assert!(!allowed(&url(blocked), &web), "{blocked}");
        }
    }

    #[test]
    fn requires_https_except_for_local_development() {
        assert!(web_origin(r#"{"webUrl":"http://10.0.2.2:3000"}"#).is_ok());
        assert!(web_origin(r#"{"webUrl":"http://localhost:3000"}"#).is_ok());
        assert!(web_origin(r#"{"webUrl":"http://ftms.example.edu"}"#).is_err());
        assert!(web_origin(r#"{"webUrl":"ftp://ftms.example.edu"}"#).is_err());
        assert!(web_origin(r#"{"webUrl":"https://u:p@ftms.example.edu"}"#).is_err());
        assert!(web_origin(r#"{"webUrl":"not a url"}"#).is_err());
        assert!(web_origin("{}").is_err());
    }

    #[test]
    fn the_dev_origin_keeps_its_port() {
        let web = web_origin(r#"{"webUrl":"http://10.0.2.2:3000"}"#).unwrap();
        assert!(allowed(&url("http://10.0.2.2:3000/login"), &web));
        assert!(!allowed(&url("http://10.0.2.2:4000/"), &web));
    }
}
