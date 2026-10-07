export const CAPABILITY_PROFILE_VERSION = 2 as const;

export type CapabilityCategory = "system" | "filesystem" | "process" | "visual" | "desktop" | "network";
export type CapabilityEffect = "read" | "mutate" | "execute";

export interface CapabilityDescriptor {
  name: string;
  category: CapabilityCategory;
  effect: CapabilityEffect;
}

export const NEXT_RELEASE_CAPABILITY_PROFILE = [
  { name: "system_info", category: "system", effect: "read" },
  { name: "ping_agent", category: "system", effect: "read" },
  { name: "get_agent_status", category: "system", effect: "read" },
  { name: "get_recent_activity", category: "system", effect: "read" },
  { name: "get_agent_diagnostics", category: "system", effect: "read" },
  { name: "describe_agent", category: "system", effect: "read" },
  { name: "list_directory", category: "filesystem", effect: "read" },
  { name: "get_file_info", category: "filesystem", effect: "read" },
  { name: "read_file", category: "filesystem", effect: "read" },
  { name: "read_multiple_files", category: "filesystem", effect: "read" },
  { name: "search_files", category: "filesystem", effect: "read" },
  { name: "search_text", category: "filesystem", effect: "read" },
  { name: "start_search_session", category: "filesystem", effect: "read" },
  { name: "more_search_results", category: "filesystem", effect: "read" },
  { name: "list_search_sessions", category: "filesystem", effect: "read" },
  { name: "stop_search_session", category: "filesystem", effect: "read" },
  { name: "read_pdf", category: "filesystem", effect: "read" },
  { name: "search_pdf", category: "filesystem", effect: "read" },
  { name: "create_pdf", category: "filesystem", effect: "mutate" },
  { name: "modify_pdf", category: "filesystem", effect: "mutate" },
  { name: "read_docx", category: "filesystem", effect: "read" },
  { name: "search_docx", category: "filesystem", effect: "read" },
  { name: "create_docx", category: "filesystem", effect: "mutate" },
  { name: "edit_docx", category: "filesystem", effect: "mutate" },
  { name: "read_xlsx_range", category: "filesystem", effect: "read" },
  { name: "write_xlsx_range", category: "filesystem", effect: "mutate" },
  { name: "create_xlsx_table", category: "filesystem", effect: "mutate" },
  { name: "set_xlsx_formula", category: "filesystem", effect: "mutate" },
  { name: "fetch_url", category: "network", effect: "read" },
  { name: "preview_file", category: "visual", effect: "read" },
  { name: "get_rich_file_info", category: "filesystem", effect: "read" },
  { name: "write_file", category: "filesystem", effect: "mutate" },
  { name: "edit_file", category: "filesystem", effect: "mutate" },
  { name: "create_directory", category: "filesystem", effect: "mutate" },
  { name: "copy_path", category: "filesystem", effect: "mutate" },
  { name: "move_path", category: "filesystem", effect: "mutate" },
  { name: "delete_path", category: "filesystem", effect: "mutate" },
  { name: "execute_command", category: "process", effect: "execute" },
  { name: "start_process", category: "process", effect: "execute" },
  { name: "read_process_output", category: "process", effect: "read" },
  { name: "send_process_input", category: "process", effect: "execute" },
  { name: "list_process_sessions", category: "process", effect: "read" },
  { name: "terminate_process_session", category: "process", effect: "execute" },
  { name: "list_system_processes", category: "process", effect: "read" },
  { name: "kill_system_process", category: "process", effect: "execute" },
  { name: "take_screenshot", category: "visual", effect: "read" },
  { name: "list_windows", category: "desktop", effect: "read" },
  { name: "get_foreground_window", category: "desktop", effect: "read" },
  { name: "activate_window", category: "desktop", effect: "execute" },
  { name: "set_window_state", category: "desktop", effect: "execute" },
  { name: "close_window", category: "desktop", effect: "execute" },
  { name: "inspect_ui_tree", category: "desktop", effect: "read" },
  { name: "find_ui_elements", category: "desktop", effect: "read" },
  { name: "perform_ui_action", category: "desktop", effect: "execute" },
  { name: "set_ui_value", category: "desktop", effect: "execute" },
  { name: "get_cursor_position", category: "desktop", effect: "read" },
  { name: "move_mouse", category: "desktop", effect: "execute" },
  { name: "click_mouse", category: "desktop", effect: "execute" },
  { name: "scroll_mouse", category: "desktop", effect: "execute" },
  { name: "type_text", category: "desktop", effect: "execute" },
  { name: "press_key", category: "desktop", effect: "execute" },
  { name: "read_clipboard", category: "desktop", effect: "read" },
  { name: "write_clipboard", category: "desktop", effect: "mutate" },
] as const satisfies readonly CapabilityDescriptor[];

export const NEXT_RELEASE_CAPABILITY_NAMES =
  NEXT_RELEASE_CAPABILITY_PROFILE.map((capability) => capability.name);
