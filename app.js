import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Keep the Supabase URL and publishable/anon key in the browser.
// NEVER put the service-role key in this file.
const SUPABASE_URL = "https://hftxvwrhinrqnuqdxzcs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_-JzmuC2v2YDdeZaeNS4OjQ_BGiKMNLl";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[char]));

let authMode = "login";
let currentUser = null;
let currentRole = null;
let notificationChannel = null;

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add("hidden"), 4000);
}

function isStaff() {
  return ["owner", "admin", "moderator"].includes(currentRole);
}
function canManagePosts() {
  return ["owner", "admin"].includes(currentRole);
}
function canManageMembers() {
  return ["owner", "admin"].includes(currentRole);
}

async function getUser() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) console.error("Could not retrieve signed-in user:", error);
  return user || null;
}

async function getMyRole(user) {
  if (!user) return null;
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("Role lookup failed:", error);
    return null;
  }
  return data?.role || null;
}

function updateAuthMode() {
  const signup = authMode === "signup";
  $("#authHeading").textContent = signup ? "Create your account" : "Sign in";
  $("#authSubmit").textContent = signup ? "Create account" : "Sign in";
  $("#nameLabel").classList.toggle("hidden", !signup);
  $("#nameInput").required = signup;
  $("#switchPrompt").textContent = signup ? "Already registered?" : "New here?";
  $("#switchAuth").textContent = signup ? "Sign in" : "Create an account";
  $("#authNotice").textContent = signup
    ? "Choose a display name and use an email you can access."
    : "Use your Student Hub email and password.";
}

function openAuth(mode = "login") {
  authMode = mode;
  updateAuthMode();
  $("#authModal").classList.remove("hidden");
}

async function refreshIdentity() {
  currentUser = await getUser();
  currentRole = await getMyRole(currentUser);

  $("#loginBtn").classList.toggle("hidden", !!currentUser);
  $("#logoutBtn").classList.toggle("hidden", !currentUser);
  $("#signedInAs").textContent = currentUser
    ? `Signed in as ${currentUser.user_metadata?.display_name || currentUser.email}`
    : "";
  $("#signedInAs").classList.toggle("hidden", !currentUser);
  $("#adminBtn").classList.toggle("hidden", !isStaff());

  if (currentUser) {
    // Bans are checked server-side through a narrowly scoped RPC.
    const { data: ban, error } = await supabase.rpc("check_my_ban");
    if (error) {
      console.error("Ban status check failed:", error);
    } else if (ban?.is_banned) {
      await supabase.auth.signOut();
      currentUser = null;
      currentRole = null;
      $("#adminBtn").classList.add("hidden");
      $("#loginBtn").classList.remove("hidden");
      $("#logoutBtn").classList.add("hidden");
      $("#signedInAs").classList.add("hidden");
      toast(`This account is suspended. Reason: ${ban.reason || "Community guidelines violation"}`);
      return;
    }
  }

  $("#notificationBtn").classList.toggle("hidden", !currentUser);
  if (currentUser) {
    await loadNotifications(false);
  } else {
    $("#notificationsPanel").classList.add("hidden");
    $("#notificationsList").textContent = "Sign in to view notifications.";
    $("#notificationCount").textContent = "0";
  }
}

$("#loginBtn").onclick = () => openAuth("login");
$("#closeAuth").onclick = () => $("#authModal").classList.add("hidden");
$("#switchAuth").onclick = () => {
  authMode = authMode === "login" ? "signup" : "login";
  updateAuthMode();
};

$("#authForm").onsubmit = async (event) => {
  event.preventDefault();
  const email = $("#emailInput").value.trim();
  const password = $("#passwordInput").value;
  $("#authSubmit").disabled = true;

  let result;
  if (authMode === "signup") {
    result = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: $("#nameInput").value.trim() } }
    });
  } else {
    result = await supabase.auth.signInWithPassword({ email, password });
  }

  $("#authSubmit").disabled = false;
  if (result.error) return toast(result.error.message);

  if (authMode === "signup" && !result.data.session) {
    $("#authModal").classList.add("hidden");
    return toast("Account created. Check your email to confirm, then sign in.");
  }

  $("#authModal").classList.add("hidden");
  $("#authForm").reset();
  await refreshIdentity();
  toast(currentUser ? (authMode === "signup" ? "Account created!" : "Welcome back!") : "Please check your account status.");
  await refreshFeeds();
};

$("#logoutBtn").onclick = async () => {
  const { error } = await supabase.auth.signOut();
  if (error) return toast(error.message);
  await refreshIdentity();
  $("#adminPanel").classList.add("hidden");
  toast("Signed out.");
  await refreshFeeds();
};

async function loadNotifications(showErrors = true) {
  const host = $("#notificationsList");
  if (!currentUser || !host) return;

  const { data, error } = await supabase
    .from("notifications")
    .select("id,type,message,is_read,created_at,post_id")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("Could not load notifications:", error);
    if (showErrors) host.textContent = `Could not load notifications: ${error.message}`;
    return;
  }

  const unread = (data || []).filter((item) => !item.is_read).length;
  $("#notificationCount").textContent = unread > 99 ? "99+" : String(unread);
  $("#notificationCount").classList.toggle("hidden", unread === 0);

  if (!data?.length) {
    host.innerHTML = '<p class="muted">You do not have any notifications yet.</p>';
    return;
  }

  host.innerHTML = data.map((item) => `
    <article class="notification-item ${item.is_read ? "read" : "unread"}" data-notification-id="${item.id}">
      <div class="notification-item-heading">
        <strong>${item.type === "post_approved" ? "Post approved" : item.type === "post_rejected" ? "Post not approved" : "Student Hub notification"}</strong>
        <span class="meta">${new Date(item.created_at).toLocaleString()}</span>
      </div>
      <p>${escapeHTML(item.message)}</p>
      ${item.is_read ? '<span class="muted">Read</span>' : '<button class="small-button" data-mark-notification-read="' + item.id + '">Mark as read</button>'}
    </article>
  `).join("");
}

async function markNotificationRead(notificationId) {
  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("id", notificationId)
    .eq("user_id", currentUser.id);
  if (error) return toast(`Could not update notification: ${error.message}`);
  await loadNotifications();
}

$("#notificationBtn").onclick = async () => {
  const panel = $("#notificationsPanel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) await loadNotifications();
};
$("#closeNotifications").onclick = () => $("#notificationsPanel").classList.add("hidden");
$("#refreshNotifications").onclick = () => loadNotifications();
$("#markAllRead").onclick = async () => {
  if (!currentUser) return;
  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("user_id", currentUser.id)
    .eq("is_read", false);
  if (error) return toast(`Could not mark notifications as read: ${error.message}`);
  await loadNotifications();
};
document.addEventListener("click", async (event) => {
  const markButton = event.target.closest("[data-mark-notification-read]");
  if (markButton) await markNotificationRead(markButton.dataset.markNotificationRead);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentUser) loadNotifications(false);
});

async function refreshFeeds() {
  await Promise.all([loadPosts("education"), loadPosts("relaxation")]);
}

async function runPostRpc(action, postId, pinned) {
  const rpcByAction = {
    pin: ["pin_post", { _post_id: postId, _pinned: pinned }],
    hide: ["hide_post", { _post_id: postId }],
    restore: ["restore_post", { _post_id: postId }],
    delete: ["delete_post", { _post_id: postId }]
  };
  const [name, args] = rpcByAction[action];
  const { error } = await supabase.rpc(name, args);
  if (error) return toast(error.message);
  toast(action === "delete" ? "Post permanently deleted." :
    action === "hide" ? "Post hidden." :
    action === "restore" ? "Post restored." :
    pinned ? "Post pinned." : "Post unpinned.");
  await refreshFeeds();
  if (!$("#adminPanel").classList.contains("hidden")) await loadAdminDashboard();
}

function postActionButtons(post, inAdmin = false) {
  if (!isStaff()) return "";
  const buttons = [];
  if (canManagePosts()) {
    buttons.push(`<button class="small-button" data-action="pin" data-id="${post.id}" data-pinned="${!post.is_pinned}">${post.is_pinned ? "Unpin" : "Pin"}</button>`);
  }
  if (post.status === "hidden") {
    buttons.push(`<button class="small-button" data-action="restore" data-id="${post.id}">Restore</button>`);
  } else {
    buttons.push(`<button class="small-button" data-action="hide" data-id="${post.id}">Hide</button>`);
  }
  if (canManagePosts()) {
    buttons.push(`<button class="small-button danger" data-action="delete" data-id="${post.id}">Delete</button>`);
  }
  return `<div class="post-actions">${buttons.join("")}</div>`;
}

async function loadPosts(section) {
  const feed = document.getElementById(`${section}Feed`);
  if (!feed) return;
  feed.textContent = "Loading posts...";

  const { data, error } = await supabase
    .from("posts")
    .select("id,title,content,author_name,created_at,is_pinned,status")
    .eq("section", section)
    .eq("status", "published")
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error(error);
    feed.textContent = "Could not load posts.";
    return;
  }
  if (!data?.length) {
    feed.textContent = "No posts yet. Be the first to share something!";
    return;
  }

  feed.innerHTML = data.map((post) => `
    <article class="post">
      ${post.is_pinned ? '<div class="pinned-label">📌 Pinned</div>' : ""}
      <div class="meta">${escapeHTML(post.author_name || "Student")} • ${new Date(post.created_at).toLocaleDateString()}</div>
      <h3>${escapeHTML(post.title)}</h3>
      <p>${escapeHTML(post.content)}</p>
      ${postActionButtons(post)}
      <button class="ghost report" data-id="${post.id}">Report</button>
    </article>
  `).join("");
}

async function reportPost(postId) {
  const user = await getUser();
  if (!user) return openAuth("login");
  const reason = prompt("Why are you reporting this post?");
  if (!reason?.trim()) return;
  const { error } = await supabase.from("reports").insert({
    post_id: postId,
    reporter_id: user.id,
    reason: reason.trim()
  });
  toast(error ? error.message : "Report sent for review.");
}

document.querySelectorAll(".jump").forEach((button) => {
  button.onclick = () => document.getElementById(button.dataset.target)
    .scrollIntoView({ behavior: "smooth" });
});

document.querySelectorAll(".new-post").forEach((button) => {
  button.onclick = async () => {
    if (!await getUser()) return openAuth("login");
    $("#sectionInput").value = button.dataset.section;
    $("#modalSection").textContent = button.dataset.section.toUpperCase();
    $("#postModal").classList.remove("hidden");
  };
});

$("#closeModal").onclick = () => $("#postModal").classList.add("hidden");

$("#postForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!await getUser()) return openAuth("login");

  $("#submitPost").disabled = true;
  const payload = {
    section: $("#sectionInput").value,
    title: $("#titleInput").value.trim(),
    content: $("#contentInput").value.trim()
  };
  const { data, error } = await supabase.functions.invoke("supabase-functions-deploy-moderate-post", { body: payload });
  $("#submitPost").disabled = false;

  if (error) return toast("Moderation service error. Post was not published.");
  if (!data?.allowed) return toast(data?.message || "Post was not approved.");

  $("#postForm").reset();
  $("#postModal").classList.add("hidden");

  if (data.status === "pending_review") {
    toast("Your post was sent to the moderator review queue.");
  } else {
    toast("Post published!");
  }

  await loadPosts(payload.section);
  if (isStaff() && !$("#adminPanel").classList.contains("hidden")) {
    await loadPendingReview();
  }
};

function adminMemberActions(member) {
  const isSelf = member.user_id === currentUser?.id;
  const isOwner = member.role === "owner";
  let actions = "";

  if (canManageMembers() && !isSelf && !isOwner && currentRole === "owner") {
    actions += `
      <button class="small-button" data-member-action="role" data-role="admin" data-id="${member.user_id}">Make admin</button>
      <button class="small-button" data-member-action="role" data-role="moderator" data-id="${member.user_id}">Make moderator</button>
      ${member.role !== "member" ? `<button class="small-button" data-member-action="remove-role" data-id="${member.user_id}">Remove role</button>` : ""}
    `;
  }
  if (canManageMembers() && !isSelf && !isOwner) {
    actions += member.is_banned
      ? `<button class="small-button" data-member-action="unban" data-id="${member.user_id}">Unban</button>`
      : `<button class="small-button danger" data-member-action="ban" data-id="${member.user_id}">Ban</button>`;
  }
  return actions || '<span class="muted">No actions available</span>';
}

async function loadMembers() {
  const host = $("#membersList");
  if (!canManageMembers()) {
    host.innerHTML = '<p class="muted">Only Owners and Admins can manage members.</p>';
    return;
  }
  host.textContent = "Loading members...";
  const { data, error } = await supabase.rpc("admin_list_members");
  if (error) {
    host.textContent = `Could not load members: ${error.message}`;
    return;
  }
  if (!data?.length) {
    host.textContent = "No members found.";
    return;
  }

  host.innerHTML = data.map((member) => `
    <div class="member-row">
      <div class="member-info">
        <strong>${escapeHTML(member.display_name || "Student")}</strong>
        <span>${escapeHTML(member.email || "")}</span>
        <span class="role-tag">${escapeHTML(member.role)}${member.is_banned ? " • BANNED" : ""}</span>
        ${member.is_banned ? `<span class="muted">Reason: ${escapeHTML(member.ban_reason || "Not supplied")}</span>` : ""}
      </div>
      <div class="member-actions">${adminMemberActions(member)}</div>
    </div>
  `).join("");
}

async function loadReports() {
  const host = $("#reportsList");
  host.textContent = "Loading reports...";
  const { data, error } = await supabase
    .from("reports")
    .select("id,reason,created_at,post_id,reporter_id,posts(title,content,author_name,section,status)")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    host.textContent = `Could not load reports: ${error.message}`;
    return;
  }
  if (!data?.length) {
    host.textContent = "No reports to review.";
    return;
  }

  host.innerHTML = data.map((report) => {
    const post = report.posts;
    return `
      <article class="admin-item">
        <div class="meta">${new Date(report.created_at).toLocaleString()} • ${escapeHTML(report.section || post?.section || "")}</div>
        <h3>${escapeHTML(post?.title || "Post no longer available")}</h3>
        <p>${escapeHTML(post?.content || "")}</p>
        <p><strong>Report reason:</strong> ${escapeHTML(report.reason)}</p>
        <p class="muted">Author: ${escapeHTML(post?.author_name || "Unknown")} • Status: ${escapeHTML(post?.status || "deleted")}</p>
        ${post ? postActionButtons({ id: report.post_id, is_pinned: false, status: post.status }, true) : ""}
      </article>
    `;
  }).join("");
}


async function runReviewRpc(action, postId) {
  const rpcName = action === "approve" ? "approve_pending_post" : "reject_pending_post";
  const { error } = await supabase.rpc(rpcName, { _post_id: postId });
  if (error) return toast(error.message);

  toast(action === "approve" ? "Post approved and published." : "Post rejected and removed.");
  await refreshFeeds();
  await loadAdminDashboard();
}

async function loadPendingReview() {
  const host = $("#pendingReviewList");
  if (!host) return;

  host.textContent = "Loading posts awaiting review...";
  const { data, error } = await supabase
    .from("posts")
    .select("id,title,content,author_name,section,created_at,moderation,status")
    .eq("status", "pending_review")
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    host.textContent = `Could not load pending posts: ${error.message}`;
    return;
  }
  if (!data?.length) {
    host.textContent = "No posts are waiting for review.";
    return;
  }

  const sensitiveCategories = new Set([
    "sexual",
    "sexual/minors",
    "self-harm",
    "self-harm/intent",
    "self-harm/instructions",
    "violence/graphic"
  ]);

  host.innerHTML = data.map((post) => {
    const categories = Object.entries(post.moderation?.categories || {})
      .filter(([, flagged]) => flagged === true)
      .map(([category]) => category);
    const categoryText = categories.length
      ? categories.map(escapeHTML).join(", ")
      : "Flagged for additional review";
    const sensitive = categories.some((category) => sensitiveCategories.has(category));

    if (sensitive) {
      return `
        <article class="admin-item">
          <div class="meta">${escapeHTML(post.section)} • ${new Date(post.created_at).toLocaleString()}</div>
          <h3>Safety-sensitive post held for adult review</h3>
          <p class="muted">The post text is intentionally hidden in this dashboard. A trusted adult should review this item. Do not copy or redistribute its contents.</p>
          <p class="muted">Flag categories: ${categoryText}</p>
          <div class="post-actions">
            <button class="small-button danger" data-review-action="reject" data-id="${post.id}">Reject and remove</button>
          </div>
        </article>
      `;
    }

    return `
      <article class="admin-item">
        <div class="meta">${escapeHTML(post.author_name || "Student")} • ${escapeHTML(post.section)} • ${new Date(post.created_at).toLocaleString()}</div>
        <h3>${escapeHTML(post.title)}</h3>
        <p>${escapeHTML(post.content)}</p>
        <p class="muted">AI flag categories: ${categoryText}</p>
        <div class="post-actions">
          <button class="small-button" data-review-action="approve" data-id="${post.id}">Approve and publish</button>
          <button class="small-button danger" data-review-action="reject" data-id="${post.id}">Reject</button>
        </div>
      </article>
    `;
  }).join("");
}

async function loadHiddenPosts() {
  const host = $("#hiddenPostsList");
  host.textContent = "Loading hidden posts...";
  const { data, error } = await supabase
    .from("posts")
    .select("id,title,content,author_name,created_at,is_pinned,status")
    .eq("status", "hidden")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    host.textContent = `Could not load hidden posts: ${error.message}`;
    return;
  }
  if (!data?.length) {
    host.textContent = "There are no hidden posts.";
    return;
  }
  host.innerHTML = data.map((post) => `
    <article class="admin-item">
      <div class="meta">${escapeHTML(post.author_name || "Student")} • ${new Date(post.created_at).toLocaleString()}</div>
      <h3>${escapeHTML(post.title)}</h3>
      <p>${escapeHTML(post.content)}</p>
      ${postActionButtons(post, true)}
    </article>
  `).join("");
}

async function loadAdminDashboard() {
  if (!isStaff()) {
    $("#adminPanel").classList.add("hidden");
    return toast("You don't have permission to access the Admin Dashboard.");
  }
  $("#adminPanel").classList.remove("hidden");
  $("#adminRoleLabel").textContent = `Signed in with ${currentRole} permissions`;
  $("#membersCard").classList.toggle("hidden", !canManageMembers());
  $("#createReviewTestPost").classList.toggle("hidden", !canManagePosts());
  await Promise.all([loadPendingReview(), loadReports(), loadHiddenPosts(), loadMembers()]);
}

$("#createReviewTestPost").onclick = async () => {
  if (!canManagePosts()) return toast("Only Owners and Admins can create review test posts.");
  const button = $("#createReviewTestPost");
  button.disabled = true;
  const { data, error } = await supabase.rpc("create_review_test_post");
  button.disabled = false;
  if (error) {
    console.error("Could not create review test post:", error);
    return toast(`Could not create test post: ${error.message}`);
  }
  toast("Harmless test post added to Pending Review.");
  await loadPendingReview();
};

$("#adminBtn").onclick = loadAdminDashboard;
$("#closeAdmin").onclick = () => $("#adminPanel").classList.add("hidden");
$("#refreshAdmin").onclick = loadAdminDashboard;

document.addEventListener("click", async (event) => {
  const reviewButton = event.target.closest("[data-review-action]");
  if (reviewButton) {
    const action = reviewButton.dataset.reviewAction;
    const postId = reviewButton.dataset.id;
    if (action === "reject" && !confirm("Reject and remove this post from Student Hub?")) return;
    await runReviewRpc(action, postId);
    return;
  }

  const postButton = event.target.closest("[data-action]");
  if (postButton) {
    const action = postButton.dataset.action;
    const postId = postButton.dataset.id;
    if (action === "delete" && !confirm("Permanently delete this post? This cannot be undone.")) return;
    await runPostRpc(action, postId, postButton.dataset.pinned === "true");
    return;
  }

  const reportButton = event.target.closest(".report");
  if (reportButton) {
    await reportPost(reportButton.dataset.id);
    return;
  }

  const memberButton = event.target.closest("[data-member-action]");
  if (!memberButton) return;
  const userId = memberButton.dataset.id;
  const action = memberButton.dataset.memberAction;

  if (action === "ban") {
    const reason = prompt("Enter the reason for this ban:");
    if (!reason?.trim()) return;
    if (!confirm("Ban this member from using their Student Hub account?")) return;
    const { error } = await supabase.rpc("ban_user", { _user_id: userId, _reason: reason.trim() });
    if (error) return toast(error.message);
    toast("Member banned.");
  } else if (action === "unban") {
    if (!confirm("Unban this member?")) return;
    const { error } = await supabase.rpc("unban_user", { _user_id: userId });
    if (error) return toast(error.message);
    toast("Member unbanned.");
  } else if (action === "role") {
    const role = memberButton.dataset.role;
    const { error } = await supabase.rpc("set_user_role", { _user_id: userId, _role: role });
    if (error) return toast(error.message);
    toast(`Member is now ${role}.`);
  } else if (action === "remove-role") {
    if (!confirm("Remove this member's staff role?")) return;
    const { error } = await supabase.rpc("remove_user_role", { _user_id: userId });
    if (error) return toast(error.message);
    toast("Staff role removed.");
  }
  await loadMembers();
});

supabase.auth.onAuthStateChange(async () => {
  await refreshIdentity();
  await refreshFeeds();
});

await refreshIdentity();
await refreshFeeds();
