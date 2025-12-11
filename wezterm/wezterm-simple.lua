-- WezTerm Configuration - Simplified for SSH + tmux
-- Copy this file to:
--   Windows: %USERPROFILE%\.wezterm.lua
--   Linux/Mac: ~/.wezterm.lua

local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- ============================================================================
-- APPEARANCE
-- ============================================================================

config.color_scheme = 'Catppuccin Mocha'
config.font = wezterm.font('JetBrains Mono', { weight = 'Medium' })
config.font_size = 11.0
config.window_background_opacity = 0.95

-- ============================================================================
-- SSH DOMAINS
-- ============================================================================

config.ssh_domains = {
  {
    name = 'godev4',
    remote_address = 'godev4',  -- Update to your server IP
    username = 'cslog',
  },
}

-- ============================================================================
-- KEYBINDINGS - SIMPLIFIED APPROACH
-- ============================================================================

config.keys = {
  -- Ctrl+Shift+P: Show Claude sessions (sends command to terminal)
  {
    key = 'p',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SendString 'ta claude\r',
  },

  -- Ctrl+Shift+T: Show ALL tmux sessions
  {
    key = 't',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SendString 'ta\r',
  },

  -- Ctrl+Shift+L: Show sessions with simple select menu
  {
    key = 'l',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.Multiple {
      wezterm.action.SendString 'PS3="Select session: "; select s in $(tmux ls -F "#{session_name}"); do tmux attach -t "$s"; break; done\r',
    },
  },

  -- Reload WezTerm configuration
  {
    key = 'r',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ReloadConfiguration,
  },

  -- Copy/Paste
  {
    key = 'c',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.CopyTo 'Clipboard',
  },
  {
    key = 'v',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.PasteFrom 'Clipboard',
  },

  -- Search
  {
    key = 'f',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.Search 'CurrentSelectionOrEmptyString',
  },

  -- New tab
  {
    key = 'n',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SpawnTab 'CurrentPaneDomain',
  },

  -- Close tab
  {
    key = 'w',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.CloseCurrentTab { confirm = true },
  },

  -- Font size
  {
    key = '+',
    mods = 'CTRL',
    action = wezterm.action.IncreaseFontSize,
  },
  {
    key = '-',
    mods = 'CTRL',
    action = wezterm.action.DecreaseFontSize,
  },
  {
    key = '0',
    mods = 'CTRL',
    action = wezterm.action.ResetFontSize,
  },
}

-- ============================================================================
-- SETTINGS
-- ============================================================================

config.scrollback_lines = 10000
config.enable_tab_bar = true
config.hide_tab_bar_if_only_one_tab = false

--[[
USAGE:

If fzf is installed on your server:
  Ctrl+Shift+P → Interactive Claude session picker
  Ctrl+Shift+T → Interactive all sessions picker

If fzf is NOT installed:
  Ctrl+Shift+L → Numbered menu (works without fzf)

To install fzf on your server:
  sudo apt install fzf
  # or
  brew install fzf

KEYBINDINGS QUICK REFERENCE:
  Ctrl+Shift+P    Claude sessions (requires fzf)
  Ctrl+Shift+T    All sessions (requires fzf)
  Ctrl+Shift+L    Sessions menu (no fzf needed)
  Ctrl+Shift+R    Reload config
  Ctrl+Shift+C    Copy
  Ctrl+Shift+V    Paste
  Ctrl+Shift+F    Search
  Ctrl+Shift+N    New tab
  Ctrl++/-/0      Font size
]]

return config
