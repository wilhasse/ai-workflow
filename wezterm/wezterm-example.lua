-- WezTerm Configuration for Native SSH + tmux Access
--
-- This configuration provides a native Windows terminal experience
-- for connecting to persistent tmux sessions on a Linux server.
--
-- Installation:
--   1. Install WezTerm from https://wezfurlong.org/wezterm/
--   2. Copy this file to %USERPROFILE%/.wezterm.lua (Windows)
--      or ~/.wezterm.lua (Linux/macOS)
--   3. Update SSH_HOST and SSH_USER below
--   4. Restart WezTerm
--
-- Usage:
--   - Alt+P: Open project launcher menu
--   - Alt+L: List all tmux sessions
--   - Alt+N: New general shell session
--   - Alt+S: Sync sessions to web dashboard

local wezterm = require 'wezterm'
local config = wezterm.config_builder()

--------------------------------------------------------------------------------
-- CONFIGURATION - Update these values for your environment
--------------------------------------------------------------------------------

-- SSH connection settings
local SSH_HOST = "your-server-hostname-or-ip"  -- e.g., "192.168.1.100" or "dev.example.com"
local SSH_USER = "cslog"                        -- Your Linux username

-- Path to helper scripts on the server
local SCRIPTS_PATH = "/home/cslog/ai-workflow/tmux-session-service/scripts"

-- Projects - Add your projects here for quick access
-- Each project gets an entry in the launcher menu (Alt+P)
local PROJECTS = {
    {
        name = "ai-workflow",
        dir = "/home/cslog/ai-workflow",
        windows = "shell,editor,logs",
    },
    -- Add more projects:
    -- {
    --     name = "my-project",
    --     dir = "/home/cslog/src/my-project",
    --     windows = "code,tests,server",
    -- },
}

--------------------------------------------------------------------------------
-- SSH Domain Configuration
--------------------------------------------------------------------------------

config.ssh_domains = {
    {
        name = 'server',
        remote_address = SSH_HOST,
        username = SSH_USER,
        -- Disable WezTerm's built-in multiplexing (we use tmux)
        multiplexing = 'None',
    },
}

--------------------------------------------------------------------------------
-- Launch Menu - Project Shortcuts
--------------------------------------------------------------------------------

config.launch_menu = {}

-- Add project entries
for _, project in ipairs(PROJECTS) do
    table.insert(config.launch_menu, {
        label = string.format("Project: %s", project.name),
        args = {
            'ssh', '-t', SSH_USER .. '@' .. SSH_HOST,
            SCRIPTS_PATH .. '/tmux-project.sh',
            project.name,
            '--windows=' .. (project.windows or 'shell,editor,logs'),
            '--dir=' .. project.dir,
            '--register',
        },
    })
end

-- Separator (visual only - shows as disabled menu item)
table.insert(config.launch_menu, {
    label = "─────────────────────────",
    args = { 'cmd', '/c', 'echo', 'separator' },
})

-- General shell
table.insert(config.launch_menu, {
    label = "General Shell (main)",
    args = {
        'ssh', '-t', SSH_USER .. '@' .. SSH_HOST,
        'tmux', 'new-session', '-A', '-s', 'main',
    },
})

-- List sessions
table.insert(config.launch_menu, {
    label = "List All Sessions",
    args = {
        'ssh', SSH_USER .. '@' .. SSH_HOST,
        SCRIPTS_PATH .. '/list-sessions.sh',
    },
})

-- Sync sessions
table.insert(config.launch_menu, {
    label = "Sync Sessions to Dashboard",
    args = {
        'ssh', SSH_USER .. '@' .. SSH_HOST,
        SCRIPTS_PATH .. '/sync-sessions.sh',
    },
})

-- Attach to any session (interactive)
table.insert(config.launch_menu, {
    label = "Attach to Session (interactive)",
    args = {
        'ssh', '-t', SSH_USER .. '@' .. SSH_HOST,
        'tmux', 'attach', '||', 'tmux',
    },
})

--------------------------------------------------------------------------------
-- Keyboard Shortcuts
--------------------------------------------------------------------------------

config.keys = {
    -- Alt+P: Open project launcher
    {
        key = 'p',
        mods = 'ALT',
        action = wezterm.action.ShowLauncherArgs { flags = 'LAUNCH_MENU_ITEMS' },
    },

    -- Alt+L: List sessions in new tab
    {
        key = 'l',
        mods = 'ALT',
        action = wezterm.action.SpawnCommandInNewTab {
            args = {
                'ssh', SSH_USER .. '@' .. SSH_HOST,
                SCRIPTS_PATH .. '/list-sessions.sh',
            },
        },
    },

    -- Alt+N: New general shell session
    {
        key = 'n',
        mods = 'ALT',
        action = wezterm.action.SpawnCommandInNewTab {
            args = {
                'ssh', '-t', SSH_USER .. '@' .. SSH_HOST,
                'tmux', 'new-session', '-A', '-s', 'main',
            },
        },
    },

    -- Alt+S: Sync sessions to web dashboard
    {
        key = 's',
        mods = 'ALT|SHIFT',
        action = wezterm.action.SpawnCommandInNewTab {
            args = {
                'ssh', SSH_USER .. '@' .. SSH_HOST,
                SCRIPTS_PATH .. '/sync-sessions.sh',
            },
        },
    },

    -- Ctrl+Shift+T: New local tab (default behavior)
    {
        key = 't',
        mods = 'CTRL|SHIFT',
        action = wezterm.action.SpawnTab 'CurrentPaneDomain',
    },
}

--------------------------------------------------------------------------------
-- Visual Settings
--------------------------------------------------------------------------------

-- Font settings
config.font = wezterm.font_with_fallback {
    'JetBrains Mono',
    'Cascadia Code',
    'Consolas',
    'Courier New',
}
config.font_size = 11.0

-- Color scheme (change to your preference)
-- Run `wezterm show-colors` to see available schemes
config.color_scheme = 'Catppuccin Mocha'

-- Window settings
config.initial_rows = 40
config.initial_cols = 140
config.window_padding = {
    left = 5,
    right = 5,
    top = 5,
    bottom = 5,
}

-- Tab bar settings
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true
config.hide_tab_bar_if_only_one_tab = false

-- Scrollback buffer
config.scrollback_lines = 10000

-- Bell
config.audible_bell = 'Disabled'

--------------------------------------------------------------------------------
-- SSH-specific Settings
--------------------------------------------------------------------------------

-- Keep SSH connections alive
config.ssh_options = {
    identities_only = false,
}

-- Don't warn about window close with running processes
-- (tmux sessions persist anyway)
config.window_close_confirmation = 'NeverPrompt'

--------------------------------------------------------------------------------
-- Status Bar (optional)
--------------------------------------------------------------------------------

-- Show hostname in tab title for SSH sessions
wezterm.on('format-tab-title', function(tab, tabs, panes, config, hover, max_width)
    local title = tab.active_pane.title
    -- Truncate if too long
    if #title > max_width - 3 then
        title = wezterm.truncate_right(title, max_width - 3) .. '...'
    end
    return title
end)

--------------------------------------------------------------------------------
-- Return Configuration
--------------------------------------------------------------------------------

return config
