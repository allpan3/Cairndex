"""Pinned migration inventory; unknown columns prohibit conversion rather than disappearing"""

# Every listed field is preserved in a reversible legacy archive, including observations
# Categories describe the eventual active representation, never permission to discard the archive
INVENTORY: dict[str, dict[str, str]] = {
    "asset_bundle_tags": {"authored": "bundle_id tag_id"},
    "asset_bundle_collections": {"authored": "bundle_id collection_id sort_order"},
    "moment_tags": {"authored": "moment_id tag_id"},
    "tag_group_memberships": {"authored": "group_id tag_id sort_order"},
    "asset_bundles": {
        "authored": (
            "id title notes rating cover_file_id primary_file_id extra_metadata "
            "manual_order grouping_state grouping_source grouping_rule_version "
            "confirmed_at created_at imported_at updated_at version"
        ),
        "observation": "last_opened_at",
    },
    "asset_files": {
        "authored": (
            "id bundle_id relative_path original_filename display_title note "
            "source role sequence cover_time created_at updated_at version"
        ),
        "observation": (
            "directory_path media_kind mime_type size_bytes mtime availability "
            "quick_fingerprint full_hash filesystem_device filesystem_inode "
            "identity_available tech_metadata"
        ),
    },
    "bundle_directory_members": {"authored": "id bundle_id directory_path sequence created_at"},
    "moments": {
        "authored": "id bundle_id file_id start_s end_s comment created_at updated_at version"
    },
    "playback_progress": {
        "legacy_resume": "file_id bundle_id position_s duration_s completed updated_at user_id"
    },
    "bundle_cursors": {"legacy_resume": "bundle_id file_id updated_at"},
    "tags": {"authored": "id parent_id name color sort_order created_at updated_at version"},
    "tag_groups": {"authored": "id name sort_order created_at updated_at"},
    "collections": {
        "authored": (
            "id parent_id name note cover_bundle_id sort_order created_at updated_at version"
        )
    },
    "smart_folders": {
        "authored": (
            "id name filter_version filter_json default_sort default_layout "
            "sort_order created_at updated_at version"
        )
    },
    "subtitle_tracks": {
        "authored": (
            "id bundle_id video_file_id source_file_id embedded_index language "
            "label format is_default is_forced sort_order created_at updated_at "
            "version"
        )
    },
    "file_operations": {"legacy_recovery": "id op status payload error created_at finished_at"},
    "plans.grouping_plans": {
        "private_plan": (
            "id scan_job_id status rule_version stem_modes input_digest "
            "generated_at applied_at created_at updated_at version"
        )
    },
    "plans.grouping_proposals": {
        "private_plan": (
            "id plan_id parent_proposal_id target_bundle_id target_bundle_title "
            "create_new_bundle target_collection_id is_collection_context "
            "base_bundle_id owner_edited membership_edited kind title directory "
            "confidence reason sort_order created_at updated_at"
        )
    },
    "plans.grouping_proposal_files": {
        "private_plan": "id proposal_id asset_file_id relative_path proposed_role sequence"
    },
    "plans.grouping_proposal_directories": {
        "private_plan": "id proposal_id directory_path expanded"
    },
}

# Conversion remains unavailable until round-trip and conflict support cover every family
CONVERSION_AVAILABLE = False
