use chrono::{DateTime, Duration, Utc};
use postkit::certificate::{build_kdm, generate_chain, KdmConfig, KdmContentKey, KdmFormulation};
use postkit::packaging::{ns, AssetMap, AssetMapAsset, DcpCpl, DcpCplReel, PackingList, PklAsset};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const RECIPIENT_ORGANIZATION: &str = "Acme";
const OTHER_RECIPIENT_ORGANIZATION: &str = "Bolt";
const KDM_TIMESTAMP_FORMAT: &str = "%Y-%m-%dT%H:%M:%S+00:00";
const PACKING_LIST_ID: &str = "0b0b0000-0000-0000-0000-000000000000";
const ASSETMAP_ID: &str = "0a0a0000-0000-0000-0000-000000000000";
const PICTURE_KEY_ID: &str = "8f2c6a10-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
const CONTENT_KEY: [u8; 16] = [0x5A; 16];
const PICTURE_WIDTH: u32 = 1998;
const PICTURE_HEIGHT: u32 = 1080;
const TEXT_XML_TYPE: &str = "text/xml";

pub const FEATURE_ID: &str = "11111111-0000-0000-0000-000000000000";
pub const TRAILER_ID: &str = "22222222-0000-0000-0000-000000000000";
pub const ORIGINAL_VERSION_ID: &str = "33333333-0000-0000-0000-000000000000";

pub struct TestComposition {
    pub id: &'static str,
    pub title: &'static str,
    pub frames_per_second: u32,
    pub reel_durations: &'static [u64],
    pub encrypted: bool,
}

pub const FEATURE: TestComposition = TestComposition {
    id: FEATURE_ID,
    title: "Feature & Credits",
    frames_per_second: 24,
    reel_durations: &[240, 480, 120],
    encrypted: false,
};

pub const TRAILER: TestComposition = TestComposition {
    id: TRAILER_ID,
    title: "Trailer",
    frames_per_second: 25,
    reel_durations: &[150, 100],
    encrypted: true,
};

pub const ORIGINAL_VERSION: TestComposition = TestComposition {
    id: ORIGINAL_VERSION_ID,
    title: "Feature & Credits OV",
    ..FEATURE
};

// the same in every composition, so an original version holds the reels its version file lacks
pub fn picture_id(reel: usize) -> String {
    format!("bbbbbbbb-0000-0000-0000-00000000000{reel}")
}

pub fn uuid(text: &str) -> uuid::Uuid {
    uuid::Uuid::parse_str(text).unwrap()
}

pub fn cpl_file_name(id: &str) -> String {
    format!("CPL_{id}.xml")
}

pub fn write_package(directory: &Path, compositions: &[TestComposition]) {
    write_package_holding(directory, compositions, |_reel| true);
}

// the asset map lists the picture of each reel holds_reel takes, a version file holds only some
pub fn write_package_holding(
    directory: &Path,
    compositions: &[TestComposition],
    holds_reel: fn(usize) -> bool,
) {
    std::fs::create_dir_all(directory).unwrap();
    let packing_list_file = format!("PKL_{PACKING_LIST_ID}.xml");
    let mut assets = vec![AssetMapAsset {
        id: PACKING_LIST_ID.into(),
        path: packing_list_file.clone(),
        packing_list: true,
    }];
    let mut packing_list_assets = Vec::new();
    for composition in compositions {
        let reels = composition
            .reel_durations
            .iter()
            .enumerate()
            .map(|(index, &duration)| DcpCplReel {
                reel_id: format!("aaaaaaaa-0000-0000-0000-00000000000{index}"),
                picture_id: picture_id(index),
                picture_edit_rate_num: composition.frames_per_second,
                picture_edit_rate_den: 1,
                picture_duration: duration,
                picture_width: PICTURE_WIDTH,
                picture_height: PICTURE_HEIGHT,
                picture_key_id: composition.encrypted.then(|| PICTURE_KEY_ID.to_string()),
                ..Default::default()
            })
            .collect();
        let cpl = DcpCpl {
            uuid: composition.id.into(),
            namespace: ns::CPL_SMPTE.into(),
            title: composition.title.into(),
            reels,
            ..Default::default()
        };
        std::fs::write(directory.join(cpl_file_name(composition.id)), cpl.to_xml()).unwrap();
        let held_reels = (0..composition.reel_durations.len()).filter(|&reel| holds_reel(reel));
        for reel in held_reels {
            let id = picture_id(reel);
            if assets.iter().any(|asset| asset.id == id) {
                continue;
            }
            assets.push(AssetMapAsset {
                path: format!("picture_{reel}.mxf"),
                id,
                packing_list: false,
            });
        }
        assets.push(AssetMapAsset {
            id: composition.id.into(),
            path: cpl_file_name(composition.id),
            packing_list: false,
        });
        packing_list_assets.push(PklAsset {
            id: composition.id.into(),
            asset_type: TEXT_XML_TYPE.into(),
            ..Default::default()
        });
    }
    let packing_list = PackingList {
        uuid: PACKING_LIST_ID.into(),
        namespace: ns::PKL_SMPTE.into(),
        assets: packing_list_assets,
        ..Default::default()
    };
    std::fs::write(directory.join(packing_list_file), packing_list.to_xml()).unwrap();
    let assetmap = AssetMap {
        uuid: ASSETMAP_ID.into(),
        namespace: ns::AM_SMPTE.into(),
        assets,
        ..Default::default()
    };
    std::fs::write(directory.join("ASSETMAP.xml"), assetmap.to_xml()).unwrap();
}

pub struct Chain {
    _directory: tempfile::TempDir,
    root: PathBuf,
    root_key: PathBuf,
    pub certificate: PathBuf,
    pub key: PathBuf,
}

fn chain(organization: &str) -> Chain {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(generate_chain(organization, directory.path()), 0);
    Chain {
        root: directory.path().join("root.pem"),
        root_key: directory.path().join("root.key"),
        certificate: directory.path().join("signer.pem"),
        key: directory.path().join("signer.key"),
        _directory: directory,
    }
}

pub fn recipient_chain() -> &'static Chain {
    static RECIPIENT: OnceLock<Chain> = OnceLock::new();
    RECIPIENT.get_or_init(|| chain(RECIPIENT_ORGANIZATION))
}

pub fn other_recipient_chain() -> &'static Chain {
    static OTHER_RECIPIENT: OnceLock<Chain> = OnceLock::new();
    OTHER_RECIPIENT.get_or_init(|| chain(OTHER_RECIPIENT_ORGANIZATION))
}

pub fn timestamp(base: DateTime<Utc>, day: i64) -> String {
    (base + Duration::days(day))
        .format(KDM_TIMESTAMP_FORMAT)
        .to_string()
}

pub struct KdmWindow {
    pub first_day: i64,
    pub last_day: i64,
}

// signed by the recipient's own root, so the chain needs no intermediate
pub fn write_kdm(
    path: &Path,
    recipient: &Chain,
    cpl_id: &str,
    base: DateTime<Utc>,
    window: KdmWindow,
) {
    let config = KdmConfig {
        cpl_id: cpl_id.to_string(),
        content_title: TRAILER.title.to_string(),
        recipient_cert_file: recipient.certificate.clone(),
        signer_cert_file: recipient.root.clone(),
        signer_key_file: recipient.root_key.clone(),
        valid_from: timestamp(base, window.first_day),
        valid_to: timestamp(base, window.last_day),
        formulation: KdmFormulation::DciAny,
        content_keys: vec![KdmContentKey {
            key_type: *b"MDIK",
            key_id: uuid(PICTURE_KEY_ID),
            content_key: CONTENT_KEY,
        }],
        ..Default::default()
    };
    std::fs::write(path, build_kdm(&config).unwrap().xml).unwrap();
}
