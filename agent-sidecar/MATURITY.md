status: green
owner: ai-agent
summary:
  - Packaging closure has landed. The Node/Mastra sidecar and a bundled Node runtime are staged into resources-bundle/ by scripts/prepare-bundle-resources.ts (invoked from build.beforeBundleCommand) and shipped via tauri.conf.json bundle.resources.
  - Runtime resolution is closed end-to-end. agent_sidecar/mod.rs resolves both the sidecar root and the Node executable with a "bundled-first -> system fallback" strategy through the shared commands::shell_tools::bundled_resource_roots() helper, which is also reused by commands/lsp/discovery.rs.
  - Writable runtime state (agent-sidecar.log and NODE_COMPILE_CACHE) is relocated to the user-writable LOCALAPPDATA/com.xiaojianc.Calamex/agent-sidecar directory, so a read-only install dir (Program Files) no longer breaks logging or the compile cache.
resolved_gaps:
  - The packaged sidecar runtime is now wired into the Tauri build and located at runtime (previously: packaged binary not wired into the build). See PACKAGING_PLAN.md (Implemented) for the step-by-step verification.
remaining_followups:
  - Dangerous tool execution stays gated behind the approval policy. Full Rust-command-backed implementations for those dangerous tools remain a separate, non-blocking follow-up tracked under their own ADR. NOTE: this item was NOT re-verified in the latest architecture review.
verified_by:
  - Evidence-based architecture review (source-of-truth = code, not docs), 2026-06-03.
