-- WezTerm Configuration for Plane Claude Automation Workflow
-- Copy this file to:
--   Linux/Mac: ~/.wezterm.lua
--   Windows: %USERPROFILE%\.wezterm.lua

local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- ============================================================================
-- APPEARANCE
-- ============================================================================

config.color_scheme = 'Catppuccin Mocha'
config.font = wezterm.font('JetBrains Mono', { weight = 'Medium' })
config.font_size = 11.0

config.window_background_opacity = 0.95
config.window_padding = {
  left = 8,
  right = 8,
  top = 8,
  bottom = 8,
}

-- Tab bar configuration
config.enable_tab_bar = true
config.hide_tab_bar_if_only_one_tab = false
config.use_fancy_tab_bar = true
config.tab_bar_at_bottom = false

-- ============================================================================
-- SSH DOMAINS (Connect to your server)
-- ============================================================================

config.ssh_domains = {
  {
    name = 'godev4',
    remote_address = 'godev4',  -- Update to your server address/IP
    username = 'cslog',

    -- Optional: Run tmux ls on connection to show available sessions
    -- default_prog = { 'bash', '-c', 'tmux ls 2>/dev/null || echo "No tmux sessions"; exec bash' },
  },
}

-- Set default domain (optional - auto-connect on launch)
-- config.default_domain = 'godev4'

-- ============================================================================
-- TMUX SESSION MANAGEMENT
-- ============================================================================

-- Custom action: Show tmux session picker
local function tmux_session_picker()
  return wezterm.action_callback(function(window, pane)
    local success, stdout, stderr = wezterm.run_child_process {
      'tmux', 'list-sessions', '-F', '#{session_name}: #{session_windows} windows (created #{t:session_created})'
    }

    if not success then
      window:toast_notification('WezTerm', 'No tmux sessions found or tmux not running', nil, 4000)
      return
    end

    local sessions = {}
    for line in stdout:gmatch('[^\r\n]+') do
      local session_name = line:match('^([^:]+)')
      if session_name then
        table.insert(sessions, {
          label = line,
          id = session_name,
        })
      end
    end

    if #sessions == 0 then
      window:toast_notification('WezTerm', 'No tmux sessions found', nil, 4000)
      return
    end

    window:perform_action(
      wezterm.action.InputSelector {
        title = '⚡ Select tmux session',
        choices = sessions,
        fuzzy = true,
        alphabet = '1234567890abcdefghijklmnopqrstuvwxyz',
        description = 'Type to filter, Enter to attach, Esc to cancel',
        action = wezterm.action_callback(function(inner_window, inner_pane, id, label)
          if id then
            inner_pane:send_text('tmux attach -t ' .. id .. '\r')
          end
        end),
      },
      pane
    )
  end)
end

-- Custom action: Show ONLY Claude automation sessions (claude-* prefix)
local function claude_session_picker()
  return wezterm.action_callback(function(window, pane)
    local success, stdout = wezterm.run_child_process {
      'tmux', 'list-sessions', '-F', '#{session_name}: #{session_windows} windows'
    }

    if not success then
      window:toast_notification('WezTerm', 'No tmux sessions found', nil, 4000)
      return
    end

    local claude_sessions = {}
    for line in stdout:gmatch('[^\r\n]+') do
      local session_name = line:match('^(claude%-[^:]+)')
      if session_name then
        table.insert(claude_sessions, {
          label = line,
          id = session_name,
        })
      end
    end

    if #claude_sessions == 0 then
      window:toast_notification('WezTerm', 'No Claude automation sessions found', nil, 4000)
      return
    end

    window:perform_action(
      wezterm.action.InputSelector {
        title = '⚡ Select Claude Code session',
        choices = claude_sessions,
        fuzzy = true,
        description = 'Plane automation sessions only',
        action = wezterm.action_callback(function(inner_window, inner_pane, id, label)
          if id then
            inner_pane:send_text('tmux attach -t ' .. id .. '\r')
          end
        end),
      },
      pane
    )
  end)
end

-- ============================================================================
-- KEYBINDINGS
-- ============================================================================

config.keys = {
  -- -------------------------------------------------------------------------
  -- TMUX Session Management
  -- -------------------------------------------------------------------------

  -- Ctrl+Shift+T: Show ALL tmux sessions
  {
    key = 't',
    mods = 'CTRL|SHIFT',
    action = tmux_session_picker(),
  },

  -- Ctrl+Shift+P: Show ONLY Claude automation sessions
  {
    key = 'p',
    mods = 'CTRL|SHIFT',
    action = claude_session_picker(),
  },

  -- Ctrl+Shift+L: Show WezTerm launcher (includes SSH domains, tabs, etc.)
  {
    key = 'l',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ShowLauncher,
  },

  -- -------------------------------------------------------------------------
  -- WezTerm Management
  -- -------------------------------------------------------------------------

  -- Ctrl+Shift+R: Reload WezTerm configuration
  {
    key = 'r',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ReloadConfiguration,
  },

  -- Ctrl+Shift+N: New tab (local shell)
  {
    key = 'n',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SpawnTab 'CurrentPaneDomain',
  },

  -- Ctrl+Shift+W: Close current tab
  {
    key = 'w',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.CloseCurrentTab { confirm = true },
  },

  -- Ctrl+Tab / Ctrl+Shift+Tab: Switch tabs
  {
    key = 'Tab',
    mods = 'CTRL',
    action = wezterm.action.ActivateTabRelative(1),
  },
  {
    key = 'Tab',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivateTabRelative(-1),
  },

  -- Ctrl+Shift+C: Copy
  {
    key = 'c',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.CopyTo 'Clipboard',
  },

  -- Ctrl+Shift+V: Paste
  {
    key = 'v',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.PasteFrom 'Clipboard',
  },

  -- Ctrl+Shift+F: Search mode
  {
    key = 'f',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.Search 'CurrentSelectionOrEmptyString',
  },

  -- -------------------------------------------------------------------------
  -- Split Panes (like tmux)
  -- -------------------------------------------------------------------------

  -- Ctrl+Shift+D: Split horizontal
  {
    key = 'd',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SplitHorizontal { domain = 'CurrentPaneDomain' },
  },

  -- Ctrl+Shift+E: Split vertical
  {
    key = 'e',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SplitVertical { domain = 'CurrentPaneDomain' },
  },

  -- Ctrl+Shift+Arrow: Navigate panes
  {
    key = 'LeftArrow',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivatePaneDirection 'Left',
  },
  {
    key = 'RightArrow',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivatePaneDirection 'Right',
  },
  {
    key = 'UpArrow',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivatePaneDirection 'Up',
  },
  {
    key = 'DownArrow',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivatePaneDirection 'Down',
  },

  -- Ctrl+Shift+X: Close current pane
  {
    key = 'x',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.CloseCurrentPane { confirm = true },
  },

  -- -------------------------------------------------------------------------
  -- Font Size
  -- -------------------------------------------------------------------------

  -- Ctrl+Plus: Increase font size
  {
    key = '+',
    mods = 'CTRL',
    action = wezterm.action.IncreaseFontSize,
  },

  -- Ctrl+Minus: Decrease font size
  {
    key = '-',
    mods = 'CTRL',
    action = wezterm.action.DecreaseFontSize,
  },

  -- Ctrl+0: Reset font size
  {
    key = '0',
    mods = 'CTRL',
    action = wezterm.action.ResetFontSize,
  },
}

-- ============================================================================
-- STATUS BAR (Show active Claude sessions)
-- ============================================================================

wezterm.on('update-right-status', function(window, pane)
  -- Get domain info (SSH connection status)
  local domain = pane:get_domain_name()
  local domain_icon = '🖥️ '
  if domain and domain ~= 'local' then
    domain_icon = '🌐 '
  end

  -- Try to count Claude automation sessions
  local success, stdout = wezterm.run_child_process { 'tmux', 'list-sessions', '-F', '#{session_name}' }
  local claude_count = 0
  local total_count = 0

  if success then
    for line in stdout:gmatch('[^\r\n]+') do
      total_count = total_count + 1
      if line:match('^claude%-') then
        claude_count = claude_count + 1
      end
    end
  end

  -- Build status string
  local status = domain_icon .. domain
  if total_count > 0 then
    status = status .. ' | 📊 ' .. total_count .. ' sessions'
    if claude_count > 0 then
      status = status .. ' (⚡ ' .. claude_count .. ' Claude)'
    end
  end

  window:set_right_status(status)
end)

-- ============================================================================
-- MOUSE BEHAVIOR
-- ============================================================================

config.mouse_bindings = {
  -- Right click pastes from clipboard
  {
    event = { Down = { streak = 1, button = 'Right' } },
    mods = 'NONE',
    action = wezterm.action.PasteFrom 'Clipboard',
  },

  -- Ctrl+Click opens URL
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'CTRL',
    action = wezterm.action.OpenLinkAtMouseCursor,
  },
}

-- ============================================================================
-- PERFORMANCE & BEHAVIOR
-- ============================================================================

-- Scrollback buffer
config.scrollback_lines = 10000

-- Performance
config.max_fps = 60
config.animation_fps = 60

-- Don't close on exit
config.exit_behavior = 'Close'

-- Enable hyperlinks
config.hyperlink_rules = wezterm.default_hyperlink_rules()

-- Custom hyperlink rule for Plane tickets (e.g., CSLOG-123)
table.insert(config.hyperlink_rules, {
  regex = '\\b([A-Z]+-\\d+)\\b',
  format = 'https://plane.cslog.com.br/$1',  -- Update to your Plane URL
})

-- ============================================================================
-- STARTUP BEHAVIOR
-- ============================================================================

-- Optional: Auto-start with SSH connection
-- Uncomment to automatically connect to godev4 on launch
-- config.default_gui_startup_args = { 'connect', 'godev4' }

-- ============================================================================
-- QUICK REFERENCE
-- ============================================================================

--[[
KEYBINDINGS QUICK REFERENCE:

Tmux Sessions:
  Ctrl+Shift+T      Show all tmux sessions
  Ctrl+Shift+P      Show Claude automation sessions only
  Ctrl+Shift+L      Show WezTerm launcher (SSH domains, tabs, etc.)

WezTerm Management:
  Ctrl+Shift+R      Reload configuration
  Ctrl+Shift+N      New tab
  Ctrl+Shift+W      Close tab
  Ctrl+Tab          Next tab
  Ctrl+Shift+Tab    Previous tab

Editing:
  Ctrl+Shift+C      Copy
  Ctrl+Shift+V      Paste
  Ctrl+Shift+F      Search

Panes:
  Ctrl+Shift+D      Split horizontal
  Ctrl+Shift+E      Split vertical
  Ctrl+Shift+Arrow  Navigate panes
  Ctrl+Shift+X      Close pane

Font:
  Ctrl++            Increase font size
  Ctrl+-            Decrease font size
  Ctrl+0            Reset font size

Usage:
1. Launch WezTerm
2. Press Ctrl+Shift+L to connect to SSH domain (godev4)
3. Once connected, press Ctrl+Shift+P to see Claude sessions
4. Select a session to attach

Or manually:
  ssh cslog@godev4
  tmux attach -t claude-CSLOG-101-20251210-222945
]]

return config
