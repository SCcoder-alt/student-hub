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
  $("#profileBtn").classList.toggle("hidden", !currentUser);
  $("#messagesBtn").classList.toggle("hidden", !currentUser);
  $("#leaderboardBtn").classList.toggle("hidden", !currentUser);
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
    .select("id,author_id,title,content,author_name,created_at,is_pinned,status")
    .eq("section", section)
    .eq("status", "published")
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) { console.error(error); feed.textContent = "Could not load posts."; return; }
  if (!data?.length) { feed.textContent = "No posts yet. Be the first to share something!"; return; }

  const ids = data.map(post => post.id);
  let likes = [], comments = [];
  if (currentUser) {
    const [likesResult, commentsResult] = await Promise.all([
      supabase.from("post_likes").select("post_id,user_id").in("post_id", ids),
      supabase.from("post_comments").select("post_id").in("post_id", ids).eq("status", "published")
    ]);
    if (!likesResult.error) likes = likesResult.data || [];
    if (!commentsResult.error) comments = commentsResult.data || [];
  }
  const likeCounts = {}, commentCounts = {}, likedByMe = new Set();
  likes.forEach(row => { likeCounts[row.post_id] = (likeCounts[row.post_id] || 0) + 1; if (row.user_id === currentUser?.id) likedByMe.add(row.post_id); });
  comments.forEach(row => { commentCounts[row.post_id] = (commentCounts[row.post_id] || 0) + 1; });

  feed.innerHTML = data.map(post => `
    <article class="post" data-post-card="${post.id}">
      ${post.is_pinned ? '<div class="pinned-label">📌 Pinned</div>' : ""}
      <div class="meta"><button class="profile-link" data-profile-id="${post.author_id}">${escapeHTML(post.author_name || "Student")}</button> • ${new Date(post.created_at).toLocaleDateString()}</div>
      <h3>${escapeHTML(post.title)}</h3>
      <p>${escapeHTML(post.content)}</p>
      <div class="social-actions">
        <button class="small-button ${likedByMe.has(post.id) ? "liked" : ""}" data-like-post="${post.id}" ${currentUser ? "" : 'disabled title="Sign in to like posts"'}>${likedByMe.has(post.id) ? "♥ Liked" : "♡ Like"} (${likeCounts[post.id] || 0})</button>
        <button class="small-button" data-open-comments="${post.id}">Comments (${commentCounts[post.id] || 0})</button>
      </div>
      <div class="comments-area hidden" id="comments-${post.id}"></div>
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


function memberPanelMarkup(content, total, pageCount) {
  const start = total ? memberPage * MEMBER_PAGE_SIZE + 1 : 0;
  const end = Math.min((memberPage + 1) * MEMBER_PAGE_SIZE, total);

  return `
    <div class="member-toolbar">
      <input
        id="memberSearchInput"
        type="search"
        placeholder="Search name or email..."
        value="${escapeHTML(memberSearch)}"
      >

      <select id="memberRoleFilter">
        <option value="all" ${memberRoleFilter === "all" ? "selected" : ""}>All roles</option>
        <option value="owner" ${memberRoleFilter === "owner" ? "selected" : ""}>Owners</option>
        <option value="admin" ${memberRoleFilter === "admin" ? "selected" : ""}>Admins</option>
        <option value="moderator" ${memberRoleFilter === "moderator" ? "selected" : ""}>Moderators</option>
        <option value="member" ${memberRoleFilter === "member" ? "selected" : ""}>Members</option>
      </select>

      <select id="memberBanFilter">
        <option value="all" ${memberBanFilter === "all" ? "selected" : ""}>All statuses</option>
        <option value="active" ${memberBanFilter === "active" ? "selected" : ""}>Active</option>
        <option value="banned" ${memberBanFilter === "banned" ? "selected" : ""}>Banned</option>
      </select>
    </div>

    <div id="memberResults">${content}</div>

    <div class="member-pagination">
      <span class="muted">
        Showing ${start}–${end} of ${total} members
      </span>

      <div>
        <button class="small-button"
          data-member-page="prev"
          ${memberPage === 0 ? "disabled" : ""}>
          Previous
        </button>

        <span>${memberPage + 1} / ${pageCount}</span>

        <button class="small-button"
          data-member-page="next"
          ${memberPage + 1 >= pageCount ? "disabled" : ""}>
          Next
        </button>
      </div>
    </div>
  `;
}

async function loadMembers() {
  const host = $("#membersList");

  if (!canManageMembers()) {
    host.textContent = "Only Owners and Admins can manage members.";
    return;
  }

  const requestId = ++memberLoadRequest;

  host.innerHTML = memberPanelMarkup(
    '<p class="muted">Loading members...</p>', 0, 1
  );

  const { data, error } = await supabase.rpc(
    "admin_list_members_page",
    {
      _search: memberSearch.trim() || null,
      _role: memberRoleFilter === "all" ? null : memberRoleFilter,
      _banned: memberBanFilter === "all"
        ? null
        : memberBanFilter === "banned",
      _limit: MEMBER_PAGE_SIZE,
      _offset: memberPage * MEMBER_PAGE_SIZE
    }
  );

  if (requestId !== memberLoadRequest) return;

  if (error) {
    host.innerHTML = memberPanelMarkup(
      `<p class="muted">Could not load members: ${escapeHTML(error.message)}</p>`,
      0, 1
    );
    return;
  }

  if (!data?.length && memberPage > 0) {
    memberPage--;
    return loadMembers();
  }

  const total = Number(data?.[0]?.total_count || 0);
  const pageCount = Math.max(1, Math.ceil(total / MEMBER_PAGE_SIZE));

  const content = data?.length
    ? data.map(member => `
        <div class="member-row">
          <div class="member-info">
            <strong>${escapeHTML(member.display_name || "Student")}</strong>
            <span>${escapeHTML(member.email || "")}</span>
            <span class="role-tag">
              ${escapeHTML(member.role)}
              ${member.is_banned ? " • BANNED" : ""}
            </span>
            ${member.is_banned
              ? `<span class="muted">Reason: ${escapeHTML(member.ban_reason || "Not supplied")}</span>`
              : ""}
          </div>

          <div class="member-actions">
            ${adminMemberActions(member)}
          </div>
        </div>
      `).join("")
    : '<p class="muted">No matching members found.</p>';

  host.innerHTML = memberPanelMarkup(content, total, pageCount);
}

// Search members
document.addEventListener("input", event => {
  if (event.target.id !== "memberSearchInput") return;

  memberSearch = event.target.value;
  memberPage = 0;

  clearTimeout(memberSearchTimer);
  memberSearchTimer = setTimeout(loadMembers, 300);
});

// Filter members
document.addEventListener("change", event => {
  if (event.target.id === "memberRoleFilter") {
    memberRoleFilter = event.target.value;
    memberPage = 0;
    loadMembers();
  }

  if (event.target.id === "memberBanFilter") {
    memberBanFilter = event.target.value;
    memberPage = 0;
    loadMembers();
  }
});

// Pagination buttons
document.addEventListener("click", event => {
  const button = event.target.closest("[data-member-page]");
  if (!button || button.disabled) return;

  if (button.dataset.memberPage === "prev") {
    memberPage = Math.max(0, memberPage - 1);
  } else {
    memberPage++;
  }

  loadMembers();
});

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


async function loadDmReports() {
  const host = $("#dmReportsList");
  if (!host) return;
  if (!isStaff()) { host.textContent = "Staff access required."; return; }
  host.textContent = "Loading reported messages...";
  const { data: reports, error } = await supabase.from("dm_reports")
    .select("id,message_id,reporter_id,reason,created_at,status")
    .eq("status", "open").order("created_at", { ascending: false }).limit(100);
  if (error) { host.textContent = `Could not load message reports: ${error.message}`; return; }
  if (!reports?.length) { host.textContent = "No open private-message reports."; return; }
  const messageIds = reports.map(r => r.message_id);
  const userIds = [...new Set(reports.map(r => r.reporter_id))];
  const [{ data: messages }, { data: reporters }] = await Promise.all([
    supabase.from("dm_messages").select("id,sender_id,body,created_at").in("id", messageIds),
    supabase.from("profiles").select("id,display_name").in("id", userIds)
  ]);
  const messageById = Object.fromEntries((messages || []).map(m => [m.id, m]));
  const nameById = Object.fromEntries((reporters || []).map(p => [p.id, p.display_name]));
  host.innerHTML = reports.map(report => {
    const message = messageById[report.message_id];
    return `<article class="admin-item"><div class="meta">${new Date(report.created_at).toLocaleString()} • Reported by ${escapeHTML(nameById[report.reporter_id] || "Student")}</div><p><strong>Reported message:</strong> ${escapeHTML(message?.body || "Message unavailable")}</p><p><strong>Reason:</strong> ${escapeHTML(report.reason)}</p><button class="small-button" data-dm-report-reviewed="${report.id}">Mark reviewed</button></article>`;
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
  await Promise.all([loadPendingReview(), loadPendingComments(), loadDmReports(), loadReports(), loadHiddenPosts(), loadMembers()]);
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


// -----------------------------------------------------------------------------
// PROFILES, COMMENTS, MESSAGING, POINTS AND ACHIEVEMENTS
// -----------------------------------------------------------------------------
let activeConversationId = null;
let activeChatOtherUserId = null;
let activeConversationType = "direct";

function showFeaturePanel(id) {
  ["profilePanel", "messagesPanel", "leaderboardPanel"].forEach(panelId => {
    const node = document.getElementById(panelId);
    if (node) node.classList.toggle("hidden", panelId !== id);
  });
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function openProfile(userId) {
  if (!currentUser) return openAuth("login");
  const { data: profile, error } = await supabase.from("profiles")
    .select("id,display_name,bio,avatar_url,updated_at").eq("id", userId).maybeSingle();
  if (error || !profile) return toast(error?.message || "Profile not found.");
  const own = profile.id === currentUser.id;
  $("#profileName").textContent = profile.display_name || "Student";
  $("#profileBio").textContent = profile.bio || "No bio yet.";
  $("#profileAvatar").innerHTML = profile.avatar_url
    ? `<img src="${escapeHTML(profile.avatar_url)}" alt="Profile picture" referrerpolicy="no-referrer">`
    : `<span>${escapeHTML((profile.display_name || "S").slice(0,1).toUpperCase())}</span>`;
  $("#profileEditForm").classList.toggle("hidden", !own);
  $("#profileMessageButton").classList.toggle("hidden", own);
  $("#profileEditName").value = profile.display_name || "";
  $("#profileEditBio").value = profile.bio || "";
  $("#profileEditAvatar").value = profile.avatar_url || "";
  $("#profileMessageButton").dataset.userId = profile.id;
  const { data: posts, error: postsError } = await supabase.from("posts")
    .select("id,title,content,section,created_at").eq("author_id", userId)
    .eq("status", "published").order("created_at", { ascending: false }).limit(30);
  $("#profilePosts").innerHTML = postsError ? `<p class="muted">Could not load post history: ${escapeHTML(postsError.message)}</p>` :
    (posts?.length ? posts.map(post => `<article class="mini-post"><span class="meta">${escapeHTML(post.section)} • ${new Date(post.created_at).toLocaleDateString()}</span><strong>${escapeHTML(post.title)}</strong><p>${escapeHTML(post.content)}</p></article>`).join("") : '<p class="muted">No published posts yet.</p>');
  showFeaturePanel("profilePanel");
}

$("#profileBtn").onclick = () => currentUser && openProfile(currentUser.id);
$("#profileMessageButton").onclick = async () => {
  const targetId = $("#profileMessageButton").dataset.userId;
  if (!targetId) return;
  showFeaturePanel("messagesPanel");
  const { error } = await supabase.rpc("create_dm_request", { _to_user_id: targetId });
  toast(error ? error.message : "Message request sent. They must accept before you can chat.");
  await loadMessagesPanel();
};
$("#profileEditForm").onsubmit = async event => {
  event.preventDefault();
  if (!currentUser) return;
  const avatar = $("#profileEditAvatar").value.trim();
  const displayName = $("#profileEditName").value.trim();
  if (avatar && !/^https:\/\//i.test(avatar)) return toast("Profile picture URL must start with https://");
  const { error: authError } = await supabase.auth.updateUser({ data: { display_name: displayName } });
  if (authError) return toast(`Could not update account name: ${authError.message}`);
  const { error } = await supabase.from("profiles").update({
    display_name: displayName,
    bio: $("#profileEditBio").value.trim(),
    avatar_url: avatar,
    updated_at: new Date().toISOString()
  }).eq("id", currentUser.id);
  if (error) return toast(`Could not save profile: ${error.message}`);
  await refreshIdentity();
  toast("Profile saved.");
  await openProfile(currentUser.id);
};

async function loadComments(postId) {
  const host = document.getElementById(`comments-${postId}`);
  if (!host) return;
  host.classList.remove("hidden");
  host.textContent = "Loading comments...";
  const { data, error } = await supabase.from("post_comments")
    .select("id,author_id,author_name,content,created_at")
    .eq("post_id", postId).eq("status", "published")
    .order("created_at", { ascending: true }).limit(100);
  if (error) { host.textContent = `Could not load comments: ${error.message}`; return; }
  host.innerHTML = `<div class="comments-list">${data?.length ? data.map(comment => `
    <div class="comment"><strong>${escapeHTML(comment.author_name || "Student")}</strong><p>${escapeHTML(comment.content)}</p><span class="meta">${new Date(comment.created_at).toLocaleString()}</span></div>
  `).join("") : '<p class="muted">No approved comments yet.</p>'}</div>
  ${currentUser ? `<form class="comment-form" data-comment-form="${postId}"><label>Add a comment<textarea name="content" maxlength="1500" required placeholder="Keep it kind and school-friendly"></textarea></label><button class="small-button" type="submit">Submit for review</button><p class="meta">Comments appear after staff approval.</p></form>` : '<p class="muted">Sign in to comment.</p>'}`;
}

async function toggleLike(postId, button) {
  if (!currentUser) return openAuth("login");
  const { data: existing, error: lookupError } = await supabase.from("post_likes")
    .select("post_id").eq("post_id", postId).eq("user_id", currentUser.id).maybeSingle();
  if (lookupError) return toast(lookupError.message);
  const result = existing
    ? await supabase.from("post_likes").delete().eq("post_id", postId).eq("user_id", currentUser.id)
    : await supabase.from("post_likes").insert({ post_id: postId, user_id: currentUser.id });
  if (result.error) return toast(result.error.message);
  await loadPosts(document.getElementById("educationFeed").contains(button) ? "education" : "relaxation");
}

async function submitComment(postId, form) {
  if (!currentUser) return openAuth("login");
  const content = new FormData(form).get("content")?.toString().trim();
  if (!content) return;
  const { error } = await supabase.from("post_comments").insert({
    post_id: postId, author_id: currentUser.id, content, status: "pending_review"
  });
  if (error) return toast(`Could not submit comment: ${error.message}`);
  toast("Comment sent to staff for approval.");
  form.reset();
}

document.addEventListener("click", async event => {
  const profileLink = event.target.closest("[data-profile-id]");
  if (profileLink) { await openProfile(profileLink.dataset.profileId); return; }
  const likeButton = event.target.closest("[data-like-post]");
  if (likeButton) { await toggleLike(likeButton.dataset.likePost, likeButton); return; }
  const commentsButton = event.target.closest("[data-open-comments]");
  if (commentsButton) {
    const postId = commentsButton.dataset.openComments;
    const host = document.getElementById(`comments-${postId}`);
    if (!currentUser) return openAuth("login");
    if (host && !host.classList.contains("hidden")) host.classList.add("hidden");
    else await loadComments(postId);
    return;
  }
});
document.addEventListener("submit", async event => {
  const form = event.target.closest("[data-comment-form]");
  if (form) { event.preventDefault(); await submitComment(form.dataset.commentForm, form); }
});

async function loadPendingComments() {
  const host = $("#pendingCommentsList");
  if (!host) return;
  if (!isStaff()) { host.textContent = "Staff access required."; return; }
  host.textContent = "Loading comments awaiting approval...";
  const { data, error } = await supabase.from("post_comments")
    .select("id,post_id,author_name,content,created_at")
    .eq("status", "pending_review").order("created_at", { ascending: true }).limit(100);
  if (error) { host.textContent = `Could not load comments: ${error.message}`; return; }
  if (!data?.length) { host.textContent = "No comments are waiting for approval."; return; }
  host.innerHTML = data.map(comment => `<article class="admin-item"><div class="meta">${escapeHTML(comment.author_name)} • ${new Date(comment.created_at).toLocaleString()}</div><p>${escapeHTML(comment.content)}</p><div class="post-actions"><button class="small-button" data-comment-review="approve" data-id="${comment.id}">Approve</button><button class="small-button danger" data-comment-review="reject" data-id="${comment.id}">Reject</button></div></article>`).join("");
}

async function searchStudents() {
  if (!currentUser) return openAuth("login");
  const term = $("#studentSearch").value.trim();
  const host = $("#studentSearchResults");
  if (term.length < 2) { host.textContent = "Type at least two letters to search students."; return; }
  const { data, error } = await supabase.from("profiles").select("id,display_name")
    .ilike("display_name", `%${term}%`).neq("id", currentUser.id).limit(10);
  if (error) { host.textContent = error.message; return; }
  if (!data?.length) { host.textContent = "No matching profiles found."; return; }
  host.innerHTML = data.map(person => `<div class="member-row"><label class="group-select-label"><input type="checkbox" data-group-select="${person.id}"> ${escapeHTML(person.display_name)}</label><button class="small-button" data-message-request="${person.id}">Request chat</button></div>`).join("");
}
$("#searchStudentsBtn").onclick = searchStudents;
$("#studentSearch").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); searchStudents(); } });

async function loadMessagesPanel() {
  if (!currentUser) return openAuth("login");
  const reqHost = $("#messageRequests");
  const convoHost = $("#conversationList");
  reqHost.textContent = "Loading requests...";
  convoHost.textContent = "Loading conversations...";

  const [{ data: requests, error: requestError }, { data: groupInvites, error: groupInviteError }] = await Promise.all([
    supabase.from("dm_requests").select("id,from_user_id,to_user_id,created_at,status")
      .eq("to_user_id", currentUser.id).eq("status", "pending").order("created_at", { ascending: false }),
    supabase.from("dm_group_invites").select("id,conversation_id,inviter_id,created_at,status")
      .eq("invited_user_id", currentUser.id).eq("status", "pending").order("created_at", { ascending: false })
  ]);
  const requestRows = [];
  if (requestError) requestRows.push(`<p class="muted">Could not load direct requests: ${escapeHTML(requestError.message)}</p>`);
  else if (requests?.length) {
    const ids = requests.map(r => r.from_user_id);
    const { data: profiles } = await supabase.from("profiles").select("id,display_name").in("id", ids);
    const names = Object.fromEntries((profiles || []).map(p => [p.id, p.display_name]));
    requestRows.push(...requests.map(r => `<div class="member-row"><strong>${escapeHTML(names[r.from_user_id] || "Student")} <span class="meta">(direct chat)</span></strong><div><button class="small-button" data-dm-accept="${r.id}">Accept</button> <button class="small-button danger" data-dm-decline="${r.id}">Decline</button></div></div>`));
  }
  if (groupInviteError) requestRows.push(`<p class="muted">Could not load group invitations: ${escapeHTML(groupInviteError.message)}</p>`);
  else if (groupInvites?.length) {
    const inviterIds = [...new Set(groupInvites.map(r => r.inviter_id))];
    const groupIds = [...new Set(groupInvites.map(r => r.conversation_id))];
    const [{ data: inviters }, { data: groups }] = await Promise.all([
      supabase.from("profiles").select("id,display_name").in("id", inviterIds),
      supabase.from("dm_conversations").select("id,title").in("id", groupIds)
    ]);
    const inviterNames = Object.fromEntries((inviters || []).map(p => [p.id, p.display_name]));
    const groupNames = Object.fromEntries((groups || []).map(g => [g.id, g.title]));
    requestRows.push(...groupInvites.map(inv => `<div class="member-row"><strong>${escapeHTML(groupNames[inv.conversation_id] || "Group chat")} <span class="meta">(invited by ${escapeHTML(inviterNames[inv.inviter_id] || "Student")})</span></strong><div><button class="small-button" data-group-accept="${inv.id}">Join</button> <button class="small-button danger" data-group-decline="${inv.id}">Decline</button></div></div>`));
  }
  reqHost.innerHTML = requestRows.length ? requestRows.join("") : "No pending requests or group invitations.";

  const { data: memberships, error: memberError } = await supabase.from("dm_conversation_members")
    .select("conversation_id").eq("user_id", currentUser.id);
  if (memberError) { convoHost.textContent = `Could not load conversations: ${memberError.message}`; return; }
  const conversationIds = (memberships || []).map(m => m.conversation_id);
  if (!conversationIds.length) { convoHost.textContent = "No accepted conversations yet."; return; }
  const [{ data: members, error: membersError }, { data: conversations, error: conversationsError }] = await Promise.all([
    supabase.from("dm_conversation_members").select("conversation_id,user_id,member_role").in("conversation_id", conversationIds),
    supabase.from("dm_conversations").select("id,conversation_type,title").in("id", conversationIds)
  ]);
  if (membersError || conversationsError) { convoHost.textContent = membersError?.message || conversationsError?.message; return; }
  const otherIds = [...new Set((members || []).filter(m => m.user_id !== currentUser.id).map(m => m.user_id))];
  const { data: profiles } = otherIds.length
    ? await supabase.from("profiles").select("id,display_name").in("id", otherIds)
    : { data: [] };
  const names = Object.fromEntries((profiles || []).map(p => [p.id, p.display_name]));
  const convById = Object.fromEntries((conversations || []).map(c => [c.id, c]));
  convoHost.innerHTML = conversationIds.map(id => {
    const conv = convById[id] || {};
    const others = (members || []).filter(m => m.conversation_id === id && m.user_id !== currentUser.id);
    const label = conv.conversation_type === "group"
      ? `${conv.title || "Group chat"} · ${others.length + 1} members`
      : (names[others[0]?.user_id] || "Student");
    return `<button class="conversation-button ${id === activeConversationId ? "selected" : ""}" data-open-conversation="${id}" data-other-user="${others[0]?.user_id || ""}">${escapeHTML(label)}</button>`;
  }).join("");
}

async function openConversation(conversationId, otherUserId) {
  activeConversationId = conversationId;
  activeChatOtherUserId = otherUserId || null;
  const host = $("#chatMessages");
  host.textContent = "Loading messages...";
  const { data: conversation, error: conversationError } = await supabase.from("dm_conversations")
    .select("id,conversation_type,title,created_by").eq("id", conversationId).maybeSingle();
  if (conversationError || !conversation) { host.textContent = conversationError?.message || "Conversation not found."; return; }
  activeConversationType = conversation.conversation_type || "direct";
  const { data, error } = await supabase.from("dm_messages")
    .select("id,sender_id,body,created_at").eq("conversation_id", conversationId)
    .order("created_at", { ascending: true }).limit(200);
  if (error) { host.textContent = `Could not load messages: ${error.message}`; return; }
  host.innerHTML = data?.length ? data.map(message => `<article class="chat-message ${message.sender_id === currentUser.id ? "mine" : "theirs"}"><p>${escapeHTML(message.body)}</p><span class="meta">${new Date(message.created_at).toLocaleString()}</span><button class="text-button" data-report-message="${message.id}">Report</button></article>`).join("") : '<p class="muted">This conversation is ready. Keep messages respectful.</p>';
  $("#chatComposer").classList.remove("hidden");
  $("#blockStudentBtn").classList.toggle("hidden", activeConversationType === "group");
  $("#leaveGroupBtn").classList.toggle("hidden", activeConversationType !== "group");
  $("#inviteSelectedGroupBtn").classList.toggle("hidden", activeConversationType !== "group");
  $("#chatComposer").dataset.conversationId = conversationId;
  const info = $("#groupChatInfo");
  if (activeConversationType === "group") {
    const { data: members, error: memberError } = await supabase.from("dm_conversation_members")
      .select("user_id,member_role").eq("conversation_id", conversationId);
    if (memberError) info.textContent = `Could not load group members: ${memberError.message}`;
    else {
      const ids = (members || []).map(m => m.user_id);
      const { data: profiles } = ids.length ? await supabase.from("profiles").select("id,display_name").in("id", ids) : { data: [] };
      const names = Object.fromEntries((profiles || []).map(p => [p.id, p.display_name]));
      const myMembership = (members || []).find(m => m.user_id === currentUser.id);
      info.innerHTML = `<strong>${escapeHTML(conversation.title || "Group chat")}</strong><p class="meta">Members: ${(members || []).length}/12</p><div class="group-member-list">${(members || []).map(m => `<span>${escapeHTML(names[m.user_id] || "Student")}${m.member_role === "owner" ? " · group owner" : ""}${myMembership?.member_role === "owner" && m.user_id !== currentUser.id ? ` <button class="text-button" data-group-remove="${m.user_id}" data-group-id="${conversationId}">Remove</button>` : ""}</span>`).join(" · ")}</div>`;
    }
  } else {
    info.textContent = "";
  }
  await loadMessagesPanel();
}

$("#chatComposer").onsubmit = async event => {
  event.preventDefault();
  if (!activeConversationId || !currentUser) return;
  const body = $("#chatInput").value.trim();
  if (!body) return;
  const button = $("#sendMessageBtn"); button.disabled = true;
  const { error } = await supabase.from("dm_messages").insert({
    conversation_id: activeConversationId, sender_id: currentUser.id, body
  });
  button.disabled = false;
  if (error) return toast(`Message not sent: ${error.message}`);
  $("#chatInput").value = "";
  await openConversation(activeConversationId, activeChatOtherUserId);
};
$("#blockStudentBtn").onclick = async () => {
  if (!activeChatOtherUserId || !confirm("Block this student? They will not be able to message you.")) return;
  const { error } = await supabase.rpc("block_student", { _blocked_user_id: activeChatOtherUserId });
  if (error) return toast(error.message);
  activeConversationId = null; activeChatOtherUserId = null;
  $("#chatMessages").textContent = "Student blocked. This conversation can no longer be used.";
  $("#chatComposer").classList.add("hidden");
  $("#blockStudentBtn").classList.add("hidden");
  $("#leaveGroupBtn").classList.add("hidden");
  $("#inviteSelectedGroupBtn").classList.add("hidden");
  $("#groupChatInfo").textContent = "";
  toast("Student blocked."); await loadMessagesPanel();
};



$("#createGroupBtn").onclick = async () => {
  if (!currentUser) return openAuth("login");
  const title = $("#groupNameInput").value.trim();
  const selected = [...document.querySelectorAll("[data-group-select]:checked")].map(node => node.dataset.groupSelect);
  if (title.length < 3 || title.length > 40) return toast("Group name must be 3–40 characters.");
  if (!selected.length) return toast("Search for students and select at least one member.");
  if (selected.length > 11) return toast("A group can have up to 12 members, including you.");
  const button = $("#createGroupBtn"); button.disabled = true;
  const { data, error } = await supabase.rpc("create_group_conversation", { _title: title, _member_ids: selected });
  button.disabled = false;
  if (error) return toast(`Could not create group: ${error.message}`);
  $("#groupNameInput").value = "";
  document.querySelectorAll("[data-group-select]").forEach(node => { node.checked = false; });
  toast("Group created. Invitations were sent for members to accept.");
  await loadMessagesPanel();
  await openConversation(data, null);
};

$("#inviteSelectedGroupBtn").onclick = async () => {
  if (!activeConversationId || activeConversationType !== "group") return;
  const selected = [...document.querySelectorAll("[data-group-select]:checked")].map(node => node.dataset.groupSelect);
  if (!selected.length) return toast("Search for students and select at least one to invite.");
  let invited = 0;
  for (const userId of selected) {
    const { error } = await supabase.rpc("invite_group_member", { _conversation_id: activeConversationId, _user_id: userId });
    if (error) { toast(`Some invitations could not be sent: ${error.message}`); break; }
    invited++;
  }
  document.querySelectorAll("[data-group-select]").forEach(node => { node.checked = false; });
  if (invited) toast(`${invited} group invitation${invited === 1 ? "" : "s"} sent.`);
  await openConversation(activeConversationId, null);
};

$("#leaveGroupBtn").onclick = async () => {
  if (!activeConversationId || activeConversationType !== "group") return;
  if (!confirm("Leave this group chat? You will need a new invitation to rejoin.")) return;
  const { error } = await supabase.rpc("leave_group_conversation", { _conversation_id: activeConversationId });
  if (error) return toast(error.message);
  activeConversationId = null; activeChatOtherUserId = null;
  $("#chatMessages").textContent = "You left the group.";
  $("#chatComposer").classList.add("hidden");
  $("#leaveGroupBtn").classList.add("hidden");
  $("#inviteSelectedGroupBtn").classList.add("hidden");
  $("#groupChatInfo").textContent = "";
  toast("You left the group."); await loadMessagesPanel();
};

$("#messagesBtn").onclick = async () => { showFeaturePanel("messagesPanel"); await loadMessagesPanel(); };
$("#leaderboardBtn").onclick = async () => { showFeaturePanel("leaderboardPanel"); await loadLeaderboard(); };

async function loadLeaderboard() {
  const host = $("#leaderboardList");
  host.textContent = "Loading points and achievements...";
  const { data, error } = await supabase.rpc("get_student_leaderboard");
  if (error) { host.textContent = `Could not load leaderboard: ${error.message}`; return; }
  if (!data?.length) { host.textContent = "Points will appear when new posts and comments are approved."; return; }
  host.innerHTML = data.map((row, index) => {
    const points = Number(row.total_points || 0);
    const badges = [points >= 100 ? "Community Builder" : null, points >= 50 ? "Helpful Contributor" : null, points >= 10 ? "First Contribution" : null].filter(Boolean);
    return `<div class="leaderboard-row"><span class="rank">${index + 1}</span><strong>${escapeHTML(row.display_name)}</strong><span class="points">${points} pts</span><div class="achievement-tags">${badges.map(b => `<span>${escapeHTML(b)}</span>`).join("")}</div></div>`;
  }).join("");
}

// Feature buttons and request/report actions.
document.addEventListener("click", async event => {
  const requestButton = event.target.closest("[data-message-request]");
  if (requestButton) {
    const { error } = await supabase.rpc("create_dm_request", { _to_user_id: requestButton.dataset.messageRequest });
    toast(error ? error.message : "Message request sent. They must accept before chatting.");
    await loadMessagesPanel(); return;
  }
  const acceptButton = event.target.closest("[data-dm-accept]");
  if (acceptButton) {
    const { error } = await supabase.rpc("accept_dm_request", { _request_id: acceptButton.dataset.dmAccept });
    if (error) toast(error.message); else toast("Request accepted. You can now chat.");
    await loadMessagesPanel(); return;
  }
  const declineButton = event.target.closest("[data-dm-decline]");
  if (declineButton) {
    const { error } = await supabase.rpc("decline_dm_request", { _request_id: declineButton.dataset.dmDecline });
    toast(error ? error.message : "Request declined."); await loadMessagesPanel(); return;
  }
  const groupAcceptButton = event.target.closest("[data-group-accept]");
  if (groupAcceptButton) {
    const { data, error } = await supabase.rpc("accept_group_invite", { _invite_id: groupAcceptButton.dataset.groupAccept });
    if (error) toast(error.message); else toast("You joined the group chat.");
    await loadMessagesPanel();
    if (data) await openConversation(data, null);
    return;
  }
  const groupDeclineButton = event.target.closest("[data-group-decline]");
  if (groupDeclineButton) {
    const { error } = await supabase.rpc("decline_group_invite", { _invite_id: groupDeclineButton.dataset.groupDecline });
    toast(error ? error.message : "Group invitation declined."); await loadMessagesPanel(); return;
  }
  const groupRemoveButton = event.target.closest("[data-group-remove]");
  if (groupRemoveButton) {
    if (!confirm("Remove this member from the group?")) return;
    const { error } = await supabase.rpc("remove_group_member", {
      _conversation_id: groupRemoveButton.dataset.groupId,
      _user_id: groupRemoveButton.dataset.groupRemove
    });
    if (error) toast(error.message); else toast("Member removed from the group.");
    await openConversation(activeConversationId, null); return;
  }
  const conversationButton = event.target.closest("[data-open-conversation]");
  if (conversationButton) { await openConversation(conversationButton.dataset.openConversation, conversationButton.dataset.otherUser); return; }
  const reportMessageButton = event.target.closest("[data-report-message]");
  if (reportMessageButton) {
    const reason = prompt("Why are you reporting this message?");
    if (!reason?.trim()) return;
    const { error } = await supabase.from("dm_reports").insert({ message_id: reportMessageButton.dataset.reportMessage, reporter_id: currentUser.id, reason: reason.trim() });
    toast(error ? error.message : "Message reported to staff."); return;
  }
  const dmReviewedButton = event.target.closest("[data-dm-report-reviewed]");
  if (dmReviewedButton) {
    const { error } = await supabase.rpc("mark_dm_report_reviewed", { _report_id: dmReviewedButton.dataset.dmReportReviewed });
    toast(error ? error.message : "Message report marked reviewed.");
    await loadDmReports(); return;
  }
  const commentReviewButton = event.target.closest("[data-comment-review]");
  if (commentReviewButton) {
    const { error } = await supabase.rpc("review_post_comment", { _comment_id: commentReviewButton.dataset.id, _decision: commentReviewButton.dataset.commentReview });
    toast(error ? error.message : (commentReviewButton.dataset.commentReview === "approve" ? "Comment approved." : "Comment rejected."));
    await loadPendingComments(); await refreshFeeds(); await loadLeaderboard(); return;
  }
});


supabase.auth.onAuthStateChange(async () => {
  await refreshIdentity();
  await refreshFeeds();
});

await refreshIdentity();
await refreshFeeds();
