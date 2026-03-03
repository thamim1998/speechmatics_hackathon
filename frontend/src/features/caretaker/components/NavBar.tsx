import { useState, useRef, useEffect } from "react";

export type TabId = "updates" | "dashboard";

interface NavBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export default function NavBar({ activeTab, onTabChange }: NavBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!settingsOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [settingsOpen]);

  return (
    <nav className="caretaker-nav">
      <div className="caretaker-nav-inner">
        <div className="caretaker-nav-brand">
          {/* Brain icon */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2a3.5 3.5 0 00-3.4 4.35A3.5 3.5 0 004 9.5a3.5 3.5 0 001.1 2.55A3.5 3.5 0 004 14.5a3.5 3.5 0 002.1 3.15A3.5 3.5 0 009.5 22h1V2h-1z" />
            <path d="M14.5 2a3.5 3.5 0 013.4 4.35A3.5 3.5 0 0120 9.5a3.5 3.5 0 01-1.1 2.55A3.5 3.5 0 0120 14.5a3.5 3.5 0 01-2.1 3.15A3.5 3.5 0 0114.5 22h-1V2h1z" />
            <path d="M8 10h2M14 10h2" />
            <path d="M8 14h2M14 14h2" />
            <path d="M10.5 2v4.5a1 1 0 001 1h1a1 1 0 001-1V2" />
          </svg>
          <span className="caretaker-nav-title">MemoryBridge AI</span>
        </div>

        <div className="caretaker-nav-tabs">
          <button
            className={`caretaker-nav-tab${activeTab === "updates" ? " active" : ""}`}
            onClick={() => onTabChange("updates")}
          >
            Caretaker Portal
          </button>
          <button
            className={`caretaker-nav-tab${activeTab === "dashboard" ? " active" : ""}`}
            onClick={() => onTabChange("dashboard")}
          >
            Dashboard
          </button>
        </div>

        <div className="caretaker-nav-right">
          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", fontWeight: 500 }}>Hello, Ayush</span>

          {/* Settings with dropdown */}
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              className={`nav-icon-btn${settingsOpen ? " active" : ""}`}
              onClick={() => setSettingsOpen(!settingsOpen)}
              title="Settings"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>

            {settingsOpen && (
              <div className="settings-dropdown">
                <div className="settings-dropdown-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
                  Light Mode
                </div>
                <div className="settings-dropdown-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>
                  Dark Mode
                </div>
                <div className="settings-dropdown-divider" />
                <div className="settings-dropdown-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                  Manage Account
                </div>
                <div className="settings-dropdown-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>
                  Notifications
                </div>
                <div className="settings-dropdown-divider" />
                <div className="settings-dropdown-item" style={{ color: "#f87171" }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                  Sign Out
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
