use crate::settings::{settings_path, Settings};
use postkit::kdm_store::{fit, KdmFit, KdmStore, StoredKdm};
use serde::Serialize;
use std::path::{Path, PathBuf};

const KDM_STORE_DIRECTORY: &str = "kdms";
const NO_CERTIFICATE_STATUS: &str = "no recipient certificate set";

pub fn kdm_store_directory() -> PathBuf {
    crate::data_dir().join(KDM_STORE_DIRECTORY)
}

pub fn load_store(directory: &Path) -> KdmStore {
    let (store, unreadable) = KdmStore::load(directory);
    for (_, reason) in &unreadable {
        eprintln!("[keys] {reason}");
    }
    store
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysListing {
    status: String,
    kdms: Vec<KdmRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KdmRow {
    path: PathBuf,
    cpl_id: String,
    content_title: String,
    not_valid_before: String,
    not_valid_after: String,
    fit: KdmFit,
}

fn kdm_row(stored: &StoredKdm, kdm_fit: KdmFit) -> KdmRow {
    KdmRow {
        path: stored.path.clone(),
        cpl_id: stored.metadata.cpl_id.to_string(),
        content_title: stored.metadata.content_title.clone(),
        not_valid_before: stored.metadata.not_valid_before.clone(),
        not_valid_after: stored.metadata.not_valid_after.clone(),
        fit: kdm_fit,
    }
}

// an empty subject matches no KDM that names a recipient
pub fn keys_listing(
    store: &KdmStore,
    recipient_subject_name: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> KeysListing {
    let subject_name = recipient_subject_name.unwrap_or_default();
    let kdms = store
        .kdms()
        .iter()
        .map(|stored| kdm_row(stored, fit(&stored.metadata, now, subject_name)))
        .collect();
    let mut status = format!("KDMs: {}", store.kdms().len());
    if recipient_subject_name.is_none() {
        status = format!("{status}, {NO_CERTIFICATE_STATUS}");
    }
    KeysListing { status, kdms }
}

#[tauri::command(async)]
pub fn keys_list() -> Result<KeysListing, String> {
    let settings = Settings::load(&settings_path())?;
    let subject_name = settings.recipient_subject_name()?;
    let store = load_store(&kdm_store_directory());
    Ok(keys_listing(
        &store,
        subject_name.as_deref(),
        chrono::Utc::now(),
    ))
}

#[tauri::command(async)]
pub fn keys_ingest(path: PathBuf) -> Result<(), String> {
    load_store(&kdm_store_directory()).ingest(&path)?;
    Ok(())
}

#[tauri::command(async)]
pub fn keys_remove(path: PathBuf) -> Result<(), String> {
    load_store(&kdm_store_directory()).remove(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::{
        other_recipient_chain, recipient_chain, timestamp, write_kdm, KdmWindow, TRAILER_ID,
    };
    use chrono::{Duration, SubsecRound, Utc};
    use serde_json::json;

    const DAYS_UNTIL_NOW: i64 = 6;

    #[test]
    fn each_kdm_is_listed_with_its_fit_against_the_certificate_and_now() {
        let directory = tempfile::tempdir().unwrap();
        let base = Utc::now().trunc_subsecs(0);
        let expired = directory.path().join("a_expired.xml");
        let other_recipient = directory.path().join("b_other_recipient.xml");
        let valid = directory.path().join("c_valid.xml");
        write_kdm(
            &expired,
            recipient_chain(),
            TRAILER_ID,
            base,
            KdmWindow {
                first_day: 1,
                last_day: 4,
            },
        );
        write_kdm(
            &other_recipient,
            other_recipient_chain(),
            TRAILER_ID,
            base,
            KdmWindow {
                first_day: 5,
                last_day: 9,
            },
        );
        write_kdm(
            &valid,
            recipient_chain(),
            TRAILER_ID,
            base,
            KdmWindow {
                first_day: 5,
                last_day: 9,
            },
        );
        let store = load_store(directory.path());
        let subject_name =
            postkit::kdm_store::recipient_subject_name(&recipient_chain().certificate).unwrap();

        let listing = keys_listing(
            &store,
            Some(&subject_name),
            base + Duration::days(DAYS_UNTIL_NOW),
        );

        let row = |path: &Path, first_day, last_day, fit| {
            json!({
                "path": path.display().to_string(),
                "cplId": TRAILER_ID,
                "contentTitle": "Trailer",
                "notValidBefore": timestamp(base, first_day),
                "notValidAfter": timestamp(base, last_day),
                "fit": fit,
            })
        };
        assert_eq!(
            serde_json::to_value(listing).unwrap(),
            json!({
                "status": "KDMs: 3",
                "kdms": [
                    row(&expired, 1, 4, "Expired"),
                    row(&other_recipient, 5, 9, "WrongRecipient"),
                    row(&valid, 5, 9, "Valid"),
                ],
            })
        );
    }

    #[test]
    fn with_no_certificate_a_kdm_in_its_window_is_the_wrong_recipient() {
        let directory = tempfile::tempdir().unwrap();
        let base = Utc::now().trunc_subsecs(0);
        let valid = directory.path().join("valid.xml");
        write_kdm(
            &valid,
            recipient_chain(),
            TRAILER_ID,
            base,
            KdmWindow {
                first_day: 5,
                last_day: 9,
            },
        );

        let listing = serde_json::to_value(keys_listing(
            &load_store(directory.path()),
            None,
            base + Duration::days(DAYS_UNTIL_NOW),
        ))
        .unwrap();

        assert_eq!(
            listing["status"],
            json!("KDMs: 1, no recipient certificate set")
        );
        assert_eq!(listing["kdms"][0]["fit"], json!("WrongRecipient"));
    }
}
