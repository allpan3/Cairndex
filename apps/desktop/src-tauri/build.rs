// Runs Tauri's build-time configuration generator
fn main() {
    println!("cargo:rerun-if-env-changed=CAIRNDEX_BUILD_COMMIT");
    tauri_build::build()
}
