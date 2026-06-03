pub(crate) mod agent;
pub(crate) mod edit;
pub(crate) mod gateway;
mod storage;
pub(crate) mod tools;
pub mod tools_generated;

pub use agent::{ai_agent_classify_task, ai_agent_set_network_permission};
pub use edit::{
    ai_apply_patch, ai_edit_create_snapshot, ai_edit_get_auth_level, ai_edit_get_diff,
    ai_edit_list_timeline, ai_edit_restore_snapshot, ai_edit_revert_file, ai_edit_revert_hunk,
    ai_edit_revert_task, ai_edit_set_auth_level, ai_edit_set_pin, ai_edit_undo_operation,
    ai_propose_patch,
};
pub use gateway::{
    ai_cancel, ai_chat_stream, ai_clear_credentials, ai_connect_provider,
    ai_generate_conversation_title, ai_generate_suggestion_pool, ai_get_config,
    ai_get_suggestion_pool_cache, ai_inline_complete, ai_save_config, ai_save_credentials,
    ai_test_provider, ai_test_provider_config,
};
pub use tools::{ai_web_fetch, ai_web_search};
