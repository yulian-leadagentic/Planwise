import { useState, useMemo } from "react";

// ─── ORGANIZATION ────────────────────────────────────────────
const CURRENT_USER = { id: 100, name: "Guy Maimoni", role: "ceo", manages: ["bim", "mep", "infrastructure"] };

const DEPARTMENTS = [
  {
    id: "bim", name: "BIM Department", headId: 10, headName: "Amit Maimoni", headInit: "AM", headColor: "#2563EB",
    members: [
      { id: 1, name: "Tom Wilson", init: "TW", color: "#059669", position: "Structural Eng.", hoursWeek: 46, capacity: 40 },
      { id: 4, name: "Jake Brown", init: "JB", color: "#2563EB", position: "BIM Coordinator", hoursWeek: 36, capacity: 40 },
      { id: 7, name: "Yael Cohen", init: "YC", color: "#EC4899", position: "BIM Modeler", hoursWeek: 8, capacity: 40 },
    ]
  },
  {
    id: "mep", name: "MEP Department", headId: 20, headName: "Sarah Johnson", headInit: "SJ", headColor: "#7C3AED",
    members: [
      { id: 2, name: "Lisa Kim", init: "LK", color: "#DC2626", position: "MEP Coordinator", hoursWeek: 48, capacity: 40 },
      { id: 6, name: "Dan Neri", init: "DN", color: "#0891B2", position: "MEP Engineer", hoursWeek: 42, capacity: 40 },
    ]
  },
  {
    id: "infrastructure", name: "Infrastructure Dept.", headId: 30, headName: "Dan Amster", headInit: "DA", headColor: "#059669",
    members: [
      { id: 3, name: "Mike Ross", init: "MR", color: "#D97706", position: "Civil Engineer", hoursWeek: 28, capacity: 40 },
      { id: 5, name: "Sara Lee", init: "SL", color: "#7C3AED", position: "Architect", hoursWeek: 15, capacity: 40 },
    ]
  },
];

const ALL_MEMBERS = DEPARTMENTS.flatMap(d => d.members.map(m => ({ ...m, deptId: d.id, deptName: d.name, headName: d.headName })));
const findMember = (init) => ALL_MEMBERS.find(m => m.init === init);

// ─── PROJECTS AT RISK ────────────────────────────────────────
const PROJECTS = [
  {
    id: 1, name: "Ramat Gan Towers", number: "PRJ-2024-045", leader: "Sarah J.", leaderInit: "SJ", leaderColor: "#7C3AED",
    progress: 45, budget: 200000, budgetUsed: 195000, daysLeft: -15, status: "critical",
    riskFactors: [
      { text: "Budget 97% used with only 45% progress", severity: "critical" },
      { text: "Deadline passed 15 days ago", severity: "critical" },
      { text: "6 tasks blocked by 2 overdue tasks", severity: "high" },
    ],
    tasks: [
      { id: "t1", code: "STR-R", name: "Structural Review", zone: "Tower A/L5", assigneeInit: "TW", hours: 8, hoursLeft: 8, daysOverdue: 12, priority: "critical", blockedTasks: 3, status: "overdue" },
      { id: "t2", code: "CR.RPT", name: "Critical Report", zone: "Tower A/L3", assigneeInit: "TW", hours: 6, hoursLeft: 6, daysOverdue: 7, priority: "high", blockedTasks: 1, status: "overdue" },
      { id: "t3", code: "OPN-C", name: "Opening Coordination", zone: "Tower A/GL", assigneeInit: "DN", hours: 12, hoursLeft: 8, daysOverdue: 3, priority: "high", blockedTasks: 0, status: "overdue" },
      { id: "t4", code: "BIM-MA", name: "Model Audit", zone: "Tower B/L2", assigneeInit: "DN", hours: 4, hoursLeft: 4, daysOverdue: 2, priority: "medium", blockedTasks: 0, status: "overdue" },
      { id: "t5", code: "MEP-C", name: "MEP Coordination", zone: "Tower B/L4", assigneeInit: "LK", hours: 16, hoursLeft: 16, priority: "high", blockedTasks: 2, status: "predicted_late", predictedDelay: 5, reason: "Lisa at 120% capacity — needs 16h but only 8h available this week" },
      { id: "t6", code: "BIM-CD", name: "Clash Detection", zone: "Tower B/L5", assigneeInit: "TW", hours: 20, hoursLeft: 20, priority: "high", blockedTasks: 4, status: "predicted_late", predictedDelay: 8, reason: "Tom overloaded (115%), depends on STR-R which is 12d late" },
    ],
  },
  {
    id: 2, name: "Park TLV Tower", number: "PRJ-2025-008", leader: "Sarah J.", leaderInit: "SJ", leaderColor: "#7C3AED",
    progress: 25, budget: 180000, budgetUsed: 155000, daysLeft: 45, status: "critical",
    riskFactors: [
      { text: "Budget 86% used with only 25% progress", severity: "critical" },
      { text: "Lisa Kim handles 44h of work from this project alone", severity: "high" },
      { text: "BIM-CD blocking 5 downstream tasks", severity: "critical" },
    ],
    tasks: [
      { id: "t10", code: "BIM-CD", name: "Clash Detection", zone: "Level 3", assigneeInit: "LK", hours: 20, hoursLeft: 20, daysOverdue: 8, priority: "critical", blockedTasks: 5, status: "overdue" },
      { id: "t11", code: "MEP-FD", name: "MEP Final Design", zone: "Basement", assigneeInit: "LK", hours: 24, hoursLeft: 20, daysOverdue: 5, priority: "high", blockedTasks: 2, status: "overdue" },
      { id: "t12", code: "STR-I", name: "Steel Inspection", zone: "Level 5", assigneeInit: "TW", hours: 12, hoursLeft: 12, priority: "medium", blockedTasks: 1, status: "predicted_late", predictedDelay: 10, reason: "Depends on BIM-CD (8d overdue). Tom has 6h/week free but needs 12h" },
      { id: "t13", code: "MEP-R", name: "MEP Routing", zone: "Level 2", assigneeInit: "DN", hours: 16, hoursLeft: 16, priority: "medium", blockedTasks: 0, status: "predicted_late", predictedDelay: 3, reason: "Dan at 105% — needs 16h, only 8h available" },
    ],
  },
  {
    id: 3, name: "Haifa Port Terminal", number: "PRJ-2025-028", leader: "Dan A.", leaderInit: "DA", leaderColor: "#059669",
    progress: 40, budget: 280000, budgetUsed: 240000, daysLeft: 60, status: "high",
    riskFactors: [{ text: "Budget 85% used with 40% progress", severity: "high" }],
    tasks: [
      { id: "t20", code: "INF-R", name: "Infrastructure Review", zone: "Terminal A", assigneeInit: "MR", hours: 16, hoursLeft: 10, daysOverdue: 3, priority: "high", blockedTasks: 2, status: "overdue" },
      { id: "t21", code: "MEP-C", name: "MEP Coordination", zone: "Terminal B", assigneeInit: "DN", hours: 20, hoursLeft: 20, priority: "medium", blockedTasks: 0, status: "predicted_late", predictedDelay: 4, reason: "Dan at 105% capacity this week" },
    ],
  },
  {
    id: 4, name: "Savioni Kiryat Ono", number: "PRJ-2025-012", leader: "Amit M.", leaderInit: "AM", leaderColor: "#2563EB",
    progress: 65, budget: 250000, budgetUsed: 168000, daysLeft: 180, status: "medium",
    riskFactors: [],
    tasks: [
      { id: "t30", code: "MEP-R", name: "MEP Review", zone: "Bld A/Typical", assigneeInit: "LK", hours: 8, hoursLeft: 8, daysOverdue: 1, priority: "medium", blockedTasks: 0, status: "overdue" },
      { id: "t31", code: "BIM-CD", name: "Clash Detection", zone: "Bld A/Roof", assigneeInit: "JB", hours: 20, hoursLeft: 20, priority: "medium", blockedTasks: 1, status: "predicted_late", predictedDelay: 2, reason: "Jake has 4h free, task needs 20h — will spill to next week" },
    ],
  },
  {
    id: 5, name: "Rishon LeZion Res.", number: "PRJ-2025-032", leader: "Sarah J.", leaderInit: "SJ", leaderColor: "#7C3AED",
    progress: 48, budget: 175000, budgetUsed: 130000, daysLeft: 100, status: "medium",
    riskFactors: [],
    tasks: [
      { id: "t40", code: "BIM-MA", name: "Model Audit", zone: "Building C", assigneeInit: "JB", hours: 4, hoursLeft: 4, daysOverdue: 2, priority: "medium", blockedTasks: 0, status: "overdue" },
    ],
  },
];

const STATUS_CFG = {
  critical: { label: "Critical", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  high:     { label: "At Risk", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  medium:   { label: "Monitor", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
};
const PRI = { critical: { c: "#DC2626" }, high: { c: "#D97706" }, medium: { c: "#2563EB" }, low: { c: "#64748B" } };

// ─── COMPONENTS ──────────────────────────────────────────────

function Av({ i, c, s = 28, ring }) {
  return <div style={{ width: s, height: s, borderRadius: "50%", background: c, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: s * 0.31, fontWeight: 600, flexShrink: 0, border: ring ? `2.5px solid ${ring}` : "2px solid #fff", boxSizing: "content-box" }}>{i}</div>;
}

function LoadBar({ used, cap, h = 5 }) {
  const pct = Math.round(used / cap * 100);
  const c = pct > 110 ? "#DC2626" : pct > 100 ? "#EF4444" : pct > 90 ? "#D97706" : pct > 60 ? "#3B82F6" : "#10B981";
  return <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ flex: 1, height: h, background: "#E2E8F0", borderRadius: h, overflow: "hidden", minWidth: 40 }}><div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: c, borderRadius: h }} /></div><span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: c, minWidth: 30, textAlign: "right" }}>{pct}%</span></div>;
}

function Chev({ open, size = 14 }) {
  return <span style={{ display: "flex", transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.2s", color: "#94A3B8" }}><svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>;
}

// ─── MAIN ────────────────────────────────────────────────────

export default function OperationsDashboard() {
  const [expandedProjects, setExpandedProjects] = useState({ 1: true, 2: true });
  const [expandedDepts, setExpandedDepts] = useState({ bim: true, mep: true });
  const [expandedMembers, setExpandedMembers] = useState({});
  const [reassignTask, setReassignTask] = useState(null);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [approvalNote, setApprovalNote] = useState("");
  const [toast, setToast] = useState(null);
  const [pendingApprovals, setPendingApprovals] = useState([]);

  const totalOverdue = PROJECTS.reduce((s, p) => s + p.tasks.filter(t => t.status === "overdue").length, 0);
  const totalPredicted = PROJECTS.reduce((s, p) => s + p.tasks.filter(t => t.status === "predicted_late").length, 0);
  const totalBlocked = PROJECTS.reduce((s, p) => s + p.tasks.reduce((s2, t) => s2 + (t.blockedTasks || 0), 0), 0);
  const overloaded = ALL_MEMBERS.filter(m => m.hoursWeek > m.capacity);
  const available = ALL_MEMBERS.filter(m => m.hoursWeek < m.capacity * 0.7);

  const startReassign = (task, projectName) => {
    const member = findMember(task.assigneeInit);
    const dept = DEPARTMENTS.find(d => d.members.some(m => m.init === task.assigneeInit));
    setReassignTask({ task, fromMember: member, fromDept: dept, projectName });
    setSelectedTarget(null);
    setApprovalNote("");
  };

  const confirmReassign = () => {
    if (!selectedTarget || !reassignTask) return;
    const targetPerson = ALL_MEMBERS.find(p => p.id === selectedTarget);
    const targetDept = DEPARTMENTS.find(d => d.members.some(m => m.id === selectedTarget));
    const isSameDept = targetDept?.id === reassignTask.fromDept?.id;
    const userManagesBoth = CURRENT_USER.manages.includes(reassignTask.fromDept?.id) && CURRENT_USER.manages.includes(targetDept?.id);
    const needsApproval = !isSameDept && !userManagesBoth;

    if (needsApproval) {
      setPendingApprovals(prev => [...prev, { id: Date.now(), task: reassignTask.task, from: reassignTask.fromMember, to: targetPerson, toDept: targetDept, approver: targetDept?.headName }]);
      setToast({ type: "approval", task: reassignTask.task.name, approver: targetDept?.headName });
    } else {
      setToast({ type: "success", task: reassignTask.task.name, to: targetPerson?.name });
    }
    setReassignTask(null);
    setTimeout(() => setToast(null), 5000);
  };

  // For modal logic
  const targetDeptForSelected = selectedTarget ? DEPARTMENTS.find(d => d.members.some(m => m.id === selectedTarget)) : null;
  const isCrossDept = reassignTask && targetDeptForSelected && targetDeptForSelected.id !== reassignTask.fromDept?.id;
  const userManagesBoth = isCrossDept && CURRENT_USER.manages.includes(reassignTask?.fromDept?.id) && CURRENT_USER.manages.includes(targetDeptForSelected?.id);
  const needsApproval = isCrossDept && !userManagesBoth;

  // Member tasks from projects data
  const getMemberTasks = (memberInit) => {
    const tasks = [];
    PROJECTS.forEach(p => p.tasks.forEach(t => { if (t.assigneeInit === memberInit) tasks.push({ ...t, projectName: p.name }); }));
    return tasks;
  };

  return (
    <div style={{ fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", minHeight: "100%", background: "#F8FAFC", padding: "20px 28px", maxWidth: 1200, margin: "0 auto" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:translateY(0) } }
      `}</style>

      {/* HEADER */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#0F172A", letterSpacing: "-0.02em" }}>Operations Dashboard</h1>
        <p style={{ margin: "3px 0 0", fontSize: 13, color: "#64748B" }}>Project risks · Team workload · Task reassignment</p>
      </div>

      {/* ═══ SUMMARY ═══ */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        {[
          { n: totalOverdue, label: "Overdue", sub: `Blocking ${totalBlocked} tasks`, bg: "#FEF2F2", border: "#FECACA", c: "#DC2626", dark: "#991B1B", light: "#B91C1C" },
          { n: totalPredicted, label: "Predicted Late", sub: "Will miss deadline at current pace", bg: "#FFFBEB", border: "#FDE68A", c: "#D97706", dark: "#92400E", light: "#A16207" },
          { n: overloaded.length, label: "Overloaded", sub: overloaded.map(m => m.name.split(" ")[0]).join(", ") || "All balanced", bg: overloaded.length ? "#FEF2F2" : "#ECFDF5", border: overloaded.length ? "#FECACA" : "#A7F3D0", c: overloaded.length ? "#DC2626" : "#059669", dark: overloaded.length ? "#991B1B" : "#065F46", light: overloaded.length ? "#B91C1C" : "#047857" },
          { n: available.length, label: "Available", sub: `${available.reduce((s, m) => s + (m.capacity - m.hoursWeek), 0)}h free capacity`, bg: "#ECFDF5", border: "#A7F3D0", c: "#059669", dark: "#065F46", light: "#047857" },
        ].map((s, i) => (
          <div key={i} style={{ flex: 1, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: s.c, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16, fontWeight: 700, flexShrink: 0 }}>{s.n}</div>
            <div><div style={{ fontSize: 13, fontWeight: 700, color: s.dark }}>{s.label}</div><div style={{ fontSize: 11, color: s.light }}>{s.sub}</div></div>
          </div>
        ))}
      </div>

      {/* PENDING APPROVALS */}
      {pendingApprovals.length > 0 && (
        <div style={{ background: "#F5F3FF", border: "1px solid #DDD6FE", borderRadius: 12, padding: "12px 18px", marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#5B21B6", marginBottom: 6 }}>⏳ Pending Approvals ({pendingApprovals.length})</div>
          {pendingApprovals.map(pa => (
            <div key={pa.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 12 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#7C3AED" }}>{pa.task.code}</span>
              <span style={{ color: "#334155", fontWeight: 500 }}>{pa.task.name}</span>
              <span style={{ color: "#94A3B8" }}>{pa.from?.name} → {pa.to?.name}</span>
              <span style={{ fontSize: 11, color: "#7C3AED", background: "#EDE9FE", padding: "2px 8px", borderRadius: 5, fontWeight: 600, marginLeft: "auto" }}>Waiting: {pa.approver}</span>
            </div>
          ))}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          SECTION 1: PROJECTS AT RISK
          ════════════════════════════════════════════════════════ */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 4, height: 20, borderRadius: 2, background: "#DC2626" }} />
          Projects at Risk
          <span style={{ fontSize: 12, fontWeight: 500, color: "#64748B" }}>— sorted by severity</span>
        </div>

        {PROJECTS.map(project => {
          const cfg = STATUS_CFG[project.status];
          const isExp = expandedProjects[project.id];
          const overdueTasks = project.tasks.filter(t => t.status === "overdue");
          const predictedTasks = project.tasks.filter(t => t.status === "predicted_late");
          const budgetPct = Math.round(project.budgetUsed / project.budget * 100);

          return (
            <div key={project.id} style={{ background: "#fff", borderRadius: 14, border: `1px solid ${isExp ? cfg.border : "#E2E8F0"}`, marginBottom: 8, overflow: "hidden", transition: "border-color 0.2s" }}>

              {/* Project header */}
              <div onClick={() => setExpandedProjects(p => ({ ...p, [project.id]: !p[project.id] }))} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer", borderLeft: `4px solid ${cfg.color}` }}
                onMouseEnter={e => e.currentTarget.style.background = "#FAFBFC"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <Chev open={isExp} />
                <span style={{ padding: "2px 9px", borderRadius: 5, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`, flexShrink: 0 }}>{cfg.label}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#0F172A" }}>{project.name}</span>
                  <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#94A3B8", marginLeft: 8 }}>{project.number}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, fontSize: 11 }}>
                  {overdueTasks.length > 0 && <span style={{ color: "#DC2626", fontWeight: 600 }}>{overdueTasks.length} overdue</span>}
                  {predictedTasks.length > 0 && <span style={{ color: "#D97706", fontWeight: 600 }}>⚡{predictedTasks.length} predicted</span>}
                  <span style={{ width: 1, height: 16, background: "#E2E8F0" }} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: budgetPct > 85 ? "#DC2626" : "#64748B", fontWeight: 600 }}>budget {budgetPct}%</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: project.daysLeft < 0 ? "#DC2626" : project.daysLeft < 30 ? "#D97706" : "#64748B", fontWeight: 600 }}>
                    {project.daysLeft < 0 ? `${Math.abs(project.daysLeft)}d overdue` : `${project.daysLeft}d left`}
                  </span>
                  <Av i={project.leaderInit} c={project.leaderColor} s={22} />
                </div>
              </div>

              {/* Expanded */}
              {isExp && (
                <div style={{ animation: "fadeIn 0.2s ease" }}>
                  {/* Risk factors */}
                  {project.riskFactors.length > 0 && (
                    <div style={{ padding: "8px 16px", background: cfg.bg, borderTop: `1px solid ${cfg.border}`, borderBottom: `1px solid ${cfg.border}`, display: "flex", gap: 16, flexWrap: "wrap" }}>
                      {project.riskFactors.map((rf, i) => (
                        <span key={i} style={{ fontSize: 12, color: cfg.color, display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: cfg.color }} />{rf.text}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Overdue tasks */}
                  {overdueTasks.length > 0 && (
                    <>
                      <div style={{ padding: "8px 16px 4px", fontSize: 12, fontWeight: 700, color: "#DC2626", display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#DC2626" }} />Overdue — immediate action needed
                      </div>
                      {overdueTasks.map(task => {
                        const m = findMember(task.assigneeInit);
                        return (
                          <div key={task.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid #F8FAFC" }}>
                            <div style={{ width: 3, height: 32, borderRadius: 2, background: PRI[task.priority]?.c, flexShrink: 0 }} />
                            <div style={{ width: 24, height: 24, borderRadius: 6, background: "#FEF2F2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#DC2626", fontWeight: 700, flexShrink: 0 }}>!</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#64748B" }}>{task.code}</span>
                                <span style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>{task.name}</span>
                                {task.blockedTasks > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#DC2626", background: "#FEF2F2", padding: "1px 5px", borderRadius: 4, border: "1px solid #FECACA" }}>blocks {task.blockedTasks}</span>}
                              </div>
                              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>{task.zone} · {task.hoursLeft}h left</div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}><Av i={m?.init} c={m?.color} s={20} /><span style={{ fontSize: 11, color: "#64748B" }}>{m?.name}</span></div>
                            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#DC2626", minWidth: 36, textAlign: "center" }}>{task.daysOverdue}d</span>
                            <button onClick={() => startReassign(task, project.name)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #E2E8F0", background: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#64748B", flexShrink: 0 }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = "#3B82F6"; e.currentTarget.style.color = "#2563EB"; e.currentTarget.style.background = "#EFF6FF"; }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = "#E2E8F0"; e.currentTarget.style.color = "#64748B"; e.currentTarget.style.background = "#fff"; }}>Reassign</button>
                          </div>
                        );
                      })}
                    </>
                  )}

                  {/* Predicted late */}
                  {predictedTasks.length > 0 && (
                    <>
                      <div style={{ padding: "8px 16px 4px", fontSize: 12, fontWeight: 700, color: "#D97706", display: "flex", alignItems: "center", gap: 5 }}>⚡ Predicted to miss deadline — act now to prevent</div>
                      {predictedTasks.map(task => {
                        const m = findMember(task.assigneeInit);
                        return (
                          <div key={task.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 16px", borderBottom: "1px solid #F8FAFC" }}>
                            <div style={{ width: 3, minHeight: 40, borderRadius: 2, background: PRI[task.priority]?.c, flexShrink: 0, marginTop: 2 }} />
                            <div style={{ width: 24, height: 24, borderRadius: 6, background: "#FFFBEB", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#D97706", flexShrink: 0, marginTop: 2 }}>⚡</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#64748B" }}>{task.code}</span>
                                <span style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>{task.name}</span>
                                {task.blockedTasks > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#DC2626", background: "#FEF2F2", padding: "1px 5px", borderRadius: 4, border: "1px solid #FECACA" }}>blocks {task.blockedTasks}</span>}
                              </div>
                              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>{task.zone} · {task.hoursLeft}h left</div>
                              {task.reason && <div style={{ fontSize: 11, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 6, padding: "4px 8px", marginTop: 5, lineHeight: 1.4 }}>⚡ <strong>+{task.predictedDelay}d:</strong> {task.reason}</div>}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginTop: 2 }}><Av i={m?.init} c={m?.color} s={20} /><span style={{ fontSize: 11, color: "#64748B" }}>{m?.name}</span></div>
                            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "#D97706", minWidth: 36, textAlign: "center", marginTop: 2 }}>+{task.predictedDelay}d</span>
                            <button onClick={() => startReassign(task, project.name)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #E2E8F0", background: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#64748B", flexShrink: 0, marginTop: 2 }}
                              onMouseEnter={e => { e.currentTarget.style.borderColor = "#3B82F6"; e.currentTarget.style.color = "#2563EB"; e.currentTarget.style.background = "#EFF6FF"; }}
                              onMouseLeave={e => { e.currentTarget.style.borderColor = "#E2E8F0"; e.currentTarget.style.color = "#64748B"; e.currentTarget.style.background = "#fff"; }}>Reassign</button>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ════════════════════════════════════════════════════════
          SECTION 2: TEAM LOAD BY DEPARTMENT
          ════════════════════════════════════════════════════════ */}
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 4, height: 20, borderRadius: 2, background: "#2563EB" }} />
          Team Load by Department
        </div>

        {DEPARTMENTS.map(dept => {
          const isExp = expandedDepts[dept.id];
          const deptHours = dept.members.reduce((s, m) => s + m.hoursWeek, 0);
          const deptCap = dept.members.reduce((s, m) => s + m.capacity, 0);
          const deptOverdue = dept.members.reduce((s, m) => s + getMemberTasks(m.init).filter(t => t.status === "overdue").length, 0);

          return (
            <div key={dept.id} style={{ background: "#fff", borderRadius: 14, border: `1px solid ${isExp ? "#CBD5E1" : "#E2E8F0"}`, marginBottom: 8, overflow: "hidden" }}>

              {/* Dept header */}
              <div onClick={() => setExpandedDepts(p => ({ ...p, [dept.id]: !p[dept.id] }))} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer", background: isExp ? "#FAFBFC" : "#fff" }}
                onMouseEnter={e => { if (!isExp) e.currentTarget.style.background = "#FAFBFC"; }} onMouseLeave={e => { if (!isExp) e.currentTarget.style.background = isExp ? "#FAFBFC" : "#fff"; }}>
                <Chev open={isExp} />
                <div style={{ width: 32, height: 32, borderRadius: 8, background: dept.headColor + "14", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: dept.headColor, flexShrink: 0 }}>{dept.members.length}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#0F172A" }}>{dept.name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2, fontSize: 12, color: "#64748B" }}>
                    <Av i={dept.headInit} c={dept.headColor} s={16} /> Head: {dept.headName}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {deptOverdue > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: "#DC2626" }}>{deptOverdue} overdue</span>}
                  <div style={{ minWidth: 80 }}><LoadBar used={deptHours} cap={deptCap} h={4} /></div>
                </div>
              </div>

              {/* Members */}
              {isExp && (
                <div style={{ borderTop: "1px solid #E2E8F0", animation: "fadeIn 0.15s ease" }}>
                  {dept.members.map(member => {
                    const pct = Math.round(member.hoursWeek / member.capacity * 100);
                    const isOver = pct > 100;
                    const isLow = pct < 60;
                    const isMExp = expandedMembers[member.id];
                    const memberTasks = getMemberTasks(member.init);
                    const problemTasks = memberTasks.filter(t => t.status === "overdue" || t.status === "predicted_late");
                    const normalTasks = memberTasks.filter(t => t.status !== "overdue" && t.status !== "predicted_late");

                    return (
                      <div key={member.id} style={{ borderBottom: "1px solid #F1F5F9" }}>
                        <div onClick={() => setExpandedMembers(p => ({ ...p, [member.id]: !p[member.id] }))} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px 8px 44px", cursor: "pointer", borderLeft: isOver ? "3px solid #DC2626" : isLow ? "3px solid #10B981" : "3px solid transparent" }}
                          onMouseEnter={e => e.currentTarget.style.background = "#FAFBFC"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <Chev open={isMExp} size={11} />
                          <Av i={member.init} c={member.color} s={28} ring={isOver ? "#DC2626" : undefined} />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>{member.name}</span>
                              {isOver && <span style={{ fontSize: 10, fontWeight: 700, color: "#DC2626", background: "#FEF2F2", padding: "1px 5px", borderRadius: 4, border: "1px solid #FECACA" }}>OVERLOADED</span>}
                              {isLow && <span style={{ fontSize: 10, fontWeight: 600, color: "#059669", background: "#ECFDF5", padding: "1px 5px", borderRadius: 4 }}>AVAILABLE</span>}
                            </div>
                            <span style={{ fontSize: 11, color: "#94A3B8" }}>{member.position} · {memberTasks.length} tasks</span>
                          </div>
                          {problemTasks.length > 0 && <span style={{ width: 20, height: 20, borderRadius: 5, background: "#FEF2F2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#DC2626" }}>{problemTasks.length}</span>}
                          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: isOver ? "#DC2626" : isLow ? "#059669" : "#334155" }}>{member.hoursWeek}h<span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 400 }}>/{member.capacity}h</span></span>
                          <div style={{ width: 70 }}><LoadBar used={member.hoursWeek} cap={member.capacity} h={4} /></div>
                        </div>

                        {isMExp && memberTasks.length > 0 && (
                          <div style={{ background: "#FAFBFC", padding: "2px 0", animation: "fadeIn 0.12s ease" }}>
                            {problemTasks.map(task => (
                              <div key={task.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 16px 6px 76px", borderBottom: "1px solid #F1F5F9", fontSize: 12 }}>
                                <div style={{ width: 3, height: 24, borderRadius: 2, background: task.status === "overdue" ? "#DC2626" : "#D97706", flexShrink: 0 }} />
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#94A3B8", minWidth: 50 }}>{task.code}</span>
                                <span style={{ flex: 1, fontWeight: 500, color: "#0F172A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.name}</span>
                                <span style={{ fontSize: 10, color: "#94A3B8" }}>{task.projectName}</span>
                                {task.status === "overdue" && <span style={{ fontSize: 10, fontWeight: 700, color: "#DC2626", background: "#FEF2F2", padding: "1px 5px", borderRadius: 4 }}>{task.daysOverdue}d late</span>}
                                {task.status === "predicted_late" && <span style={{ fontSize: 10, fontWeight: 700, color: "#D97706", background: "#FFFBEB", padding: "1px 5px", borderRadius: 4 }}>⚡+{task.predictedDelay}d</span>}
                                <button onClick={(e) => { e.stopPropagation(); startReassign(task, task.projectName); }} style={{ padding: "2px 8px", borderRadius: 5, border: "1px solid #E2E8F0", background: "#fff", cursor: "pointer", fontSize: 10, fontWeight: 600, color: "#64748B" }}
                                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#3B82F6"; e.currentTarget.style.color = "#2563EB"; }} onMouseLeave={e => { e.currentTarget.style.borderColor = "#E2E8F0"; e.currentTarget.style.color = "#64748B"; }}>Reassign</button>
                              </div>
                            ))}
                            {normalTasks.map(task => (
                              <div key={task.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 16px 4px 76px", borderBottom: "1px solid #F8FAFC", fontSize: 11, opacity: 0.5 }}>
                                <div style={{ width: 3, height: 16, borderRadius: 2, background: "#E2E8F0", flexShrink: 0 }} />
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#CBD5E1", minWidth: 50 }}>{task.code}</span>
                                <span style={{ flex: 1, color: "#94A3B8" }}>{task.name}</span>
                                <span style={{ fontSize: 10, color: "#CBD5E1" }}>{task.projectName}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ═══ REASSIGN MODAL ═══ */}
      {reassignTask && (
        <div onClick={() => setReassignTask(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, animation: "fadeIn 0.12s" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, boxShadow: "0 25px 60px rgba(0,0,0,0.2)", width: 500, maxWidth: "92vw", maxHeight: "85vh", overflow: "auto", animation: "fadeIn 0.15s ease" }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #F1F5F9" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A" }}>Reassign Task</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#64748B" }}>{reassignTask.task.code}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>{reassignTask.task.name}</span>
                <span style={{ fontSize: 11, color: "#94A3B8" }}>· {reassignTask.task.hoursLeft}h · {reassignTask.projectName}</span>
              </div>
              <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 3 }}>From: <strong style={{ color: "#334155" }}>{reassignTask.fromMember?.name}</strong> ({reassignTask.fromDept?.name})</div>
            </div>

            <div style={{ padding: "10px 12px", maxHeight: 380, overflow: "auto" }}>
              {DEPARTMENTS.map(dept => {
                const avail = dept.members.filter(m => m.id !== reassignTask.fromMember?.id && m.hoursWeek < m.capacity);
                if (avail.length === 0) return null;
                const isSame = dept.id === reassignTask.fromDept?.id;
                return (
                  <div key={dept.id} style={{ marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 8px", fontSize: 11, fontWeight: 600, color: isSame ? "#059669" : "#64748B" }}>
                      <Av i={dept.headInit} c={dept.headColor} s={16} />
                      <span style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>{dept.name}</span>
                      <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: "normal", color: isSame ? "#059669" : "#D97706" }}>{isSame ? "— direct transfer" : `— needs ${dept.headName}'s approval`}</span>
                    </div>
                    {avail.map(m => {
                      const free = m.capacity - m.hoursWeek;
                      const fits = free >= reassignTask.task.hoursLeft;
                      const isSel = selectedTarget === m.id;
                      return (
                        <button key={m.id} onClick={() => setSelectedTarget(m.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 9, border: isSel ? `1.5px solid ${isSame ? "#059669" : "#3B82F6"}` : "1px solid transparent", background: isSel ? (isSame ? "#ECFDF5" : "#EFF6FF") : "transparent", cursor: "pointer", textAlign: "left", transition: "all 0.12s" }}
                          onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = "#F8FAFC"; }} onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = isSel ? (isSame ? "#ECFDF5" : "#EFF6FF") : "transparent"; }}>
                          <Av i={m.init} c={m.color} s={30} ring={isSel ? (isSame ? "#059669" : "#3B82F6") : undefined} />
                          <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>{m.name}</div><div style={{ fontSize: 11, color: "#94A3B8" }}>{m.position}</div></div>
                          <div style={{ textAlign: "right" }}><div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: fits ? "#059669" : "#D97706" }}>{free}h</div><div style={{ fontSize: 10, color: fits ? "#059669" : "#D97706" }}>{fits ? "fits" : "partial"}</div></div>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* Transfer type indicator */}
            {selectedTarget && (
              <div style={{ padding: "0 20px 10px", animation: "fadeIn 0.1s ease" }}>
                {!isCrossDept && <div style={{ background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#065F46" }}>✓ Same department — immediate transfer, no approval needed.</div>}
                {isCrossDept && userManagesBoth && <div style={{ background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#065F46" }}>✓ You manage both departments — immediate transfer. Heads will be notified.</div>}
                {needsApproval && (
                  <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#92400E", marginBottom: 6 }}>⚠ Cross-department — {targetDeptForSelected?.headName} must approve</div>
                    <textarea value={approvalNote} onChange={e => setApprovalNote(e.target.value)} placeholder="Note for department head (optional)..." rows={2} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #FDE68A", fontSize: 12, resize: "none", outline: "none", background: "#fff", fontFamily: "inherit" }} />
                  </div>
                )}
              </div>
            )}

            <div style={{ padding: "10px 20px", borderTop: "1px solid #F1F5F9", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setReassignTask(null)} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #E2E8F0", background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#64748B" }}>Cancel</button>
              <button onClick={confirmReassign} disabled={!selectedTarget} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: selectedTarget ? (needsApproval ? "#D97706" : "#059669") : "#CBD5E1", cursor: selectedTarget ? "pointer" : "default", fontSize: 13, fontWeight: 600, color: "#fff" }}>
                {needsApproval ? "Request Approval" : "Reassign Task"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOAST */}
      {toast && (
        <div style={{ position: "fixed", top: 20, right: 28, background: "#fff", borderRadius: 12, padding: "12px 18px", zIndex: 300, animation: "fadeIn 0.2s ease", boxShadow: "0 8px 30px rgba(0,0,0,0.08)", display: "flex", alignItems: "center", gap: 10, border: `1px solid ${toast.type === "approval" ? "#DDD6FE" : "#A7F3D0"}`, borderLeft: `4px solid ${toast.type === "approval" ? "#7C3AED" : "#10B981"}` }}>
          <span style={{ width: 22, height: 22, borderRadius: "50%", background: toast.type === "approval" ? "#F5F3FF" : "#ECFDF5", display: "flex", alignItems: "center", justifyContent: "center", color: toast.type === "approval" ? "#7C3AED" : "#059669", fontSize: 12 }}>{toast.type === "approval" ? "⏳" : "✓"}</span>
          <div><div style={{ fontSize: 13, fontWeight: 600, color: toast.type === "approval" ? "#5B21B6" : "#065F46" }}>{toast.type === "approval" ? "Approval request sent" : "Task reassigned"}</div><div style={{ fontSize: 12, color: toast.type === "approval" ? "#7C3AED" : "#047857" }}>{toast.type === "approval" ? `${toast.task} — waiting for ${toast.approver}` : `${toast.task} → ${toast.to}`}</div></div>
        </div>
      )}
    </div>
  );
}
