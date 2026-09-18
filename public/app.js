const $ = (id) => document.getElementById(id);
let current = null;

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showError(error) { $("error").textContent = error.message; }
function clearError() { $("error").textContent = ""; }

$("goal-form").addEventListener("submit", async (event) => {
  event.preventDefault(); clearError();
  try {
    const goal = await api("/goals", { method: "POST", body: JSON.stringify({ title: $("title").value, description: $("description").value }) });
    $("goal-id").value = goal.id;
    $("goal").textContent = `${goal.title} · ${goal.id}`;
    const plan = await api(`/goals/${goal.id}/project-pulse`, { method: "POST" });
    await loadPlan(goal.id, plan.id);
  } catch (error) { showError(error); }
});

$("demo").addEventListener("click", async () => { try { await createDemoPlan($("goal-id").value); } catch (error) { showError(error); } });
$("load").addEventListener("click", async () => { try { await loadPlan($("goal-id").value); } catch (error) { showError(error); } });
$("context").addEventListener("click", async () => {
  try {
    if (!current) throw new Error("Load a plan first");
    const manifest = await api(`/plans/${current.plan.id}/context`, { method: "POST", body: JSON.stringify({ purpose: "project_pulse", query: "project goal decision" }) });
    $("manifest").textContent = JSON.stringify(manifest, null, 2);
  } catch (error) { showError(error); }
});
$("memory-form").addEventListener("submit", async (event) => {
  event.preventDefault(); clearError();
  try {
    if (!$("goal-id").value) throw new Error("Create or load a goal first");
    await api(`/goals/${$("goal-id").value}/memories`, { method: "POST", body: JSON.stringify({ kind: "note", content: $("memory").value }) });
    $("memory").value = "";
  } catch (error) { showError(error); }
});

async function createDemoPlan(goalId) {
  const plan = await api(`/goals/${goalId}/plans`, { method: "POST", body: JSON.stringify({ nodes: [
    { id: "understand", title: "Understand the goal" },
    { id: "execute", title: "Execute the next action", dependsOn: ["understand"] },
    { id: "review", title: "Review the outcome", kind: "review", dependsOn: ["execute"] },
  ] }) });
  await loadPlan(goalId, plan.id);
}

async function loadPlan(goalId, planId) {
  if (planId) current = await api(`/plans/${planId}`);
  else {
    const data = await api(`/goals/${goalId}`);
    if (!data.plans?.length) throw new Error("This goal has no plan");
    current = await api(`/plans/${data.plans[0].id}`);
  }
  $("goal-id").value = current.goal.id;
  $("goal").textContent = `${current.goal.title} · ${current.goal.id}`;
  render();
}

function render() {
  $("nodes").innerHTML = current.plan.nodes.map((node) => `<article class="node ${escapeHtml(node.status)}"><div class="status">${escapeHtml(node.status)}</div><strong>${escapeHtml(node.title)}</strong><div class="muted">${escapeHtml(node.id)}${node.dependsOn.length ? ` · after ${escapeHtml(node.dependsOn.join(", "))}` : ""}</div>${action(node)}</article>`).join("");
  $("nodes").querySelectorAll("button[data-task]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/plans/${current.plan.id}/tasks/${button.dataset.task}/transitions`, { method: "POST", body: JSON.stringify({ transition: button.dataset.transition }) }); current = await api(`/plans/${current.plan.id}`); render(); } catch (error) { showError(error); }
  }));
  $("receipts").innerHTML = current.receipts.length ? current.receipts.slice().reverse().map((receipt) => `<div class="receipt"><strong>${receipt.transition}</strong> · ${receipt.taskId}<br /><span class="muted">${receipt.from} → ${receipt.to} · ${new Date(receipt.occurredAt).toLocaleString()}</span></div>`).join("") : '<p class="muted">No receipts.</p>';
}

function action(node) {
  const transition = node.status === "ready" ? "start" : node.status === "running" ? "succeed" : node.status === "waiting" || node.status === "needs_approval" || node.status === "blocked" ? "start" : node.status === "failed" || node.status === "unknown" ? "retry" : null;
  return transition ? `<button data-task="${escapeHtml(node.id)}" data-transition="${transition}">${transition}</button>` : "";
}
function escapeHtml(value) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character])); }
