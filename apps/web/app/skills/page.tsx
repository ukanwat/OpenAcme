"use client";

import { useState, useEffect, useMemo } from "react";
import { Sidebar } from "../components/Sidebar";

interface SkillIndexEntry {
  name: string;
  description: string;
  tags: string[];
}

interface Skill {
  name: string;
  description: string;
  tags: string[];
  body: string;
  relatedSkills: string[];
}

// Use same origin when served from the API server, otherwise fallback to localhost
const API_BASE = typeof window !== "undefined" && window.location.port === "3210"
  ? ""
  : (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3210");

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillIndexEntry[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);

  // Create form state
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    tags: "",
    body: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/skills`);
      if (res.ok) {
        const data = await res.json();
        setSkills(data);
      } else {
        setError("Failed to load skills");
      }
    } catch {
      setError("Failed to load skills. Is the server running?");
    } finally {
      setLoading(false);
    }
  };

  const loadSkillDetail = async (name: string) => {
    setIsCreating(false);
    try {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedSkill(data);
      }
    } catch {
      setError("Failed to load skill details");
    }
  };

  const createSkill = async () => {
    if (!formData.name.trim() || !formData.description.trim()) {
      setError("Name and description are required");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const res = await fetch(`${API_BASE}/api/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          tags: formData.tags.split(",").map(t => t.trim()).filter(Boolean),
          body: formData.body,
        }),
      });

      if (res.ok) {
        setSuccess("Skill created successfully!");
        setFormData({ name: "", description: "", tags: "", body: "" });
        setIsCreating(false);
        loadSkills();
        setTimeout(() => setSuccess(""), 3000);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to create skill");
      }
    } catch {
      setError("Failed to create skill");
    } finally {
      setSaving(false);
    }
  };

  const deleteSkill = async (name: string) => {
    if (!confirm(`Delete skill "${name}"?`)) return;

    try {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setSuccess("Skill deleted");
        setSelectedSkill(null);
        loadSkills();
        setTimeout(() => setSuccess(""), 3000);
      } else {
        setError("Failed to delete skill");
      }
    } catch {
      setError("Failed to delete skill");
    }
  };

  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [skills, searchQuery]);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    skills.forEach((s) => s.tags.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [skills]);

  return (
    <div className="app-layout">
      <Sidebar />

      <main className="main-content">
        <header className="chat-header">
          <div className="chat-header-title">
            <h2>Skills</h2>
            <span className="chat-header-model">{skills.length} skills</span>
          </div>
        </header>

        {/* Status messages */}
        {error && (
          <div style={{ padding: "12px 24px", background: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: "13px" }}>
            {error}
            <button onClick={() => setError("")} style={{ marginLeft: "12px", background: "none", border: "none", color: "#ef4444", cursor: "pointer" }}>Dismiss</button>
          </div>
        )}
        {success && (
          <div style={{ padding: "12px 24px", background: "rgba(34,197,94,0.1)", color: "#22c55e", fontSize: "13px" }}>
            {success}
          </div>
        )}

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Skills List */}
          <div
            style={{
              width: "360px",
              borderRight: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Header with Create button */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>Skills</span>
              <button
                onClick={() => { setIsCreating(true); setSelectedSkill(null); }}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  background: "var(--accent-primary)",
                  border: "none",
                  color: "white",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                + New
              </button>
            </div>

            {/* Search */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search skills..."
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border)",
                  color: "var(--text-primary)",
                  fontSize: "13px",
                }}
              />
            </div>

            {/* Tags */}
            {allTags.length > 0 && (
              <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {allTags.slice(0, 10).map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setSearchQuery(tag)}
                    style={{
                      padding: "2px 8px",
                      borderRadius: "100px",
                      background: searchQuery === tag ? "var(--accent-glow)" : "var(--bg-tertiary)",
                      border: searchQuery === tag ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
                      color: searchQuery === tag ? "var(--accent-secondary)" : "var(--text-muted)",
                      fontSize: "11px",
                      cursor: "pointer",
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            {/* Skills List */}
            <div style={{ flex: 1, overflow: "auto", padding: "8px" }}>
              {loading && (
                <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)" }}>Loading...</div>
              )}

              {!loading && filteredSkills.length === 0 && (
                <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)" }}>
                  {skills.length === 0 ? "No skills yet. Create one!" : "No matching skills"}
                </div>
              )}

              {filteredSkills.map((skill) => (
                <div
                  key={skill.name}
                  onClick={() => loadSkillDetail(skill.name)}
                  style={{
                    padding: "10px 12px",
                    background: selectedSkill?.name === skill.name ? "var(--accent-glow)" : "var(--bg-tertiary)",
                    borderRadius: "6px",
                    marginBottom: "6px",
                    cursor: "pointer",
                    border: selectedSkill?.name === skill.name ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
                  }}
                >
                  <div style={{ fontWeight: 500, color: "var(--text-primary)", marginBottom: "2px", fontSize: "14px" }}>
                    {skill.name}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {skill.description}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Skill Detail / Create Form */}
          <div style={{ flex: 1, overflow: "auto", padding: "24px" }}>
            {isCreating ? (
              <div style={{ maxWidth: "700px" }}>
                <h3 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "20px", color: "var(--text-primary)" }}>
                  Create New Skill
                </h3>

                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", color: "var(--text-secondary)" }}>Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="my-skill"
                    style={{ width: "100%", padding: "10px 12px", borderRadius: "6px", background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: "14px" }}
                  />
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", color: "var(--text-secondary)" }}>Description</label>
                  <input
                    type="text"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="A brief description of what this skill does"
                    style={{ width: "100%", padding: "10px 12px", borderRadius: "6px", background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: "14px" }}
                  />
                </div>

                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", color: "var(--text-secondary)" }}>Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={formData.tags}
                    onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                    placeholder="automation, testing, deployment"
                    style={{ width: "100%", padding: "10px 12px", borderRadius: "6px", background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: "14px" }}
                  />
                </div>

                <div style={{ marginBottom: "20px" }}>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", color: "var(--text-secondary)" }}>Instructions (Markdown)</label>
                  <textarea
                    value={formData.body}
                    onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                    placeholder="Detailed instructions for the agent..."
                    rows={12}
                    style={{ width: "100%", padding: "12px", borderRadius: "6px", background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: "14px", fontFamily: "var(--font-mono)", resize: "vertical" }}
                  />
                </div>

                <div style={{ display: "flex", gap: "12px" }}>
                  <button
                    onClick={createSkill}
                    disabled={saving}
                    style={{
                      padding: "10px 20px",
                      borderRadius: "6px",
                      background: "var(--accent-primary)",
                      border: "none",
                      color: "white",
                      fontSize: "14px",
                      cursor: saving ? "not-allowed" : "pointer",
                      opacity: saving ? 0.7 : 1,
                    }}
                  >
                    {saving ? "Creating..." : "Create Skill"}
                  </button>
                  <button
                    onClick={() => setIsCreating(false)}
                    style={{
                      padding: "10px 20px",
                      borderRadius: "6px",
                      background: "var(--bg-tertiary)",
                      border: "1px solid var(--border)",
                      color: "var(--text-primary)",
                      fontSize: "14px",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : selectedSkill ? (
              <div style={{ maxWidth: "700px" }}>
                <div style={{ marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <h2 style={{ fontSize: "22px", fontWeight: 600, marginBottom: "6px", color: "var(--text-primary)" }}>
                      {selectedSkill.name}
                    </h2>
                    <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                      {selectedSkill.description}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteSkill(selectedSkill.name)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: "6px",
                      background: "rgba(239,68,68,0.1)",
                      border: "1px solid rgba(239,68,68,0.3)",
                      color: "#ef4444",
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    Delete
                  </button>
                </div>

                {selectedSkill.tags.length > 0 && (
                  <div style={{ display: "flex", gap: "6px", marginBottom: "20px", flexWrap: "wrap" }}>
                    {selectedSkill.tags.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          padding: "4px 10px",
                          borderRadius: "100px",
                          background: "var(--accent-glow)",
                          border: "1px solid var(--accent-primary)",
                          color: "var(--accent-secondary)",
                          fontSize: "12px",
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {selectedSkill.relatedSkills.length > 0 && (
                  <div style={{ marginBottom: "20px" }}>
                    <h4 style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-muted)", marginBottom: "8px" }}>Related Skills</h4>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {selectedSkill.relatedSkills.map((name) => (
                        <button
                          key={name}
                          onClick={() => loadSkillDetail(name)}
                          style={{
                            padding: "4px 10px",
                            borderRadius: "6px",
                            background: "var(--bg-tertiary)",
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                            fontSize: "12px",
                            cursor: "pointer",
                          }}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <h4 style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-muted)", marginBottom: "10px" }}>Instructions</h4>
                  <div
                    style={{
                      background: "var(--bg-tertiary)",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      padding: "16px",
                      fontSize: "14px",
                      lineHeight: 1.6,
                      color: "var(--text-primary)",
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {selectedSkill.body || "(No instructions)"}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "48px", marginBottom: "16px" }}>📚</div>
                  <p>Select a skill or create a new one</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
