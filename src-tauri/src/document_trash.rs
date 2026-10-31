use std::path::Path;

#[cfg(target_os = "macos")]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    native_trash_with_finder_fallback(move_to_native_trash(path), || {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::default();
        context.set_delete_method(DeleteMethod::Finder);
        context.delete(path).map_err(|error| error.to_string())
    })
}

#[cfg(target_os = "macos")]
fn native_trash_with_finder_fallback(
    native_result: Result<(), String>,
    finder_trash: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    match native_result {
        Ok(()) => Ok(()),
        Err(native_error) => {
            eprintln!("[document_trash_fallback] {native_error}\nTrying Finder Trash.");
            finder_trash().map_err(|finder_error| {
                format!("{native_error}\n\nFinder Trash error: {finder_error}")
            })
        }
    }
}

#[cfg(target_os = "macos")]
fn move_to_native_trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    // Match the trash crate's native API, retaining NSError diagnostics that its
    // Display conversion discards. Never retry using permanent deletion.
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let path = path.to_str().ok_or("The document path is not valid UTF-8.")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| native_error_details(&error))
}

#[cfg(target_os = "macos")]
fn native_error_details(error: &objc2_foundation::NSError) -> String {
    format!(
        "Native Trash error: {error}\nDomain: {}\nCode: {}\nUser info: {}",
        error.domain(),
        error.code(),
        error.userInfo().description(),
    )
}

#[cfg(not(target_os = "macos"))]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    trash::TrashContext::default()
        .delete(path)
        .map_err(|error| error.to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    #[ignore = "Moves a disposable file to the real system Trash; run explicitly on macOS"]
    fn native_trash_moves_disposable_file() {
        let path = std::env::temp_dir().join(format!("fablecraft-trash-probe-{}.fable", uuid::Uuid::new_v4()));
        std::fs::write(&path, "Disposable Fablecraft Trash diagnostic").unwrap();
        super::move_to_native_trash(&path).expect("native Trash should accept the disposable file");
        assert!(!path.exists());
    }

    #[test]
    fn native_success_does_not_invoke_finder() {
        assert!(super::native_trash_with_finder_fallback(Ok(()), || {
            panic!("Finder must not be called after native success")
        }).is_ok());
    }

    #[test]
    fn finder_success_recovers_native_failure() {
        let mut called = false;
        let result = super::native_trash_with_finder_fallback(Err("native denied".into()), || {
            called = true;
            Ok(())
        });
        assert!(result.is_ok());
        assert!(called);
    }

    #[test]
    fn failure_keeps_both_native_and_finder_diagnostics() {
        let error = super::native_trash_with_finder_fallback(Err("native denied".into()), || {
            Err("automation denied".into())
        }).unwrap_err();
        assert!(error.contains("native denied"));
        assert!(error.contains("Finder Trash error: automation denied"));
    }

    #[test]
    fn native_error_details_preserve_domain_and_code() {
        use objc2_foundation::{NSError, NSString};

        // SAFETY: The domain is a valid NSString and no userInfo objects are supplied.
        let error = unsafe {
            NSError::errorWithDomain_code_userInfo(
                &NSString::from_str("NSPOSIXErrorDomain"), 13, None,
            )
        };
        let details = super::native_error_details(&error);
        assert!(details.contains("Domain: NSPOSIXErrorDomain"));
        assert!(details.contains("Code: 13"));
        assert!(details.contains("User info:"));
    }
}
