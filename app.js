import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "PASTE_YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_KEY";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (s) => document.querySelector(s);
const toast = (msg) => { $("#toast").textContent = msg; $("#toast").classList.remove("hidden"); setTimeout(()=>$("#toast").classList.add("hidden"), 3500); };

async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

async function renderAuth() {
  const user = await getUser();
  $("#loginBtn").classList.toggle("hidden", !!user);
  $("#logoutBtn").classList.toggle("hidden", !user);
}

$("#loginBtn").onclick = async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) toast(error.message);
};

$("#logoutBtn").onclick = async () => {
  await supabase.auth.signOut();
  toast("Signed out.");
  await renderAuth();
};

async function loadPosts(section) {
  const feed = document.getElementById(section + "Feed");
  feed.innerHTML = `<p class="empty">Loading posts...</p>`;
  const { data, error } = await supabase
    .from("posts")
    .select("id,title,content,author_name,created_at")
    .eq("section", section)
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) { feed.innerHTML = `<p class="empty">Could not load posts.</p>`; return; }
  if (!data.length) { feed.innerHTML = `<p class="empty">No posts yet. Be the first to share something!</p>`; return; }

  feed.innerHTML = data.map(p => `
    <article class="post">
      <div class="meta">${escapeHtml(p.author_name || "Student")} • ${new Date(p.created_at).toLocaleDateString()}</div>
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.content)}</p>
      <button class="ghost report" data-id="${p.id}">Report</button>
    </article>`).join("");

  document.querySelectorAll(".report").forEach(btn => btn.onclick = () => reportPost(btn.dataset.id));
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

async function reportPost(post_id) {
  const user = await getUser();
  if (!user) return toast("Please sign in first.");
  const reason = prompt("Briefly explain why you are reporting this post:");
  if (!reason) return;
  const { error } = await supabase.from("reports").insert({ post_id, reporter_id: user.id, reason });
  toast(error ? error.message : "Report sent for review.");
}

document.querySelectorAll(".jump").forEach(b => b.onclick = () => document.getElementById(b.dataset.target).scrollIntoView({behavior:"smooth"}));
document.querySelectorAll(".new-post").forEach(b => b.onclick = async () => {
  if (!await getUser()) return toast("Please sign in with Microsoft first.");
  $("#sectionInput").value = b.dataset.section;
  $("#modalSection").textContent = b.dataset.section.toUpperCase();
  $("#postModal").classList.remove("hidden");
});
$("#closeModal").onclick = () => $("#postModal").classList.add("hidden");

$("#postForm").onsubmit = async (e) => {
  e.preventDefault();
  const user = await getUser();
  if (!user) return toast("Please sign in again.");

  $("#submitPost").disabled = true;
  $("#submitPost").textContent = "Checking post...";

  const payload = {
    section: $("#sectionInput").value,
    title: $("#titleInput").value.trim(),
    content: $("#contentInput").value.trim()
  };

  const { data, error } = await supabase.functions.invoke("moderate-post", { body: payload });
  $("#submitPost").disabled = false;
  $("#submitPost").textContent = "Submit for review";

  if (error) return toast("Moderation service error. Post was not published.");
  if (!data?.allowed) return toast(data?.message || "This post could not be published.");

  $("#postForm").reset();
  $("#postModal").classList.add("hidden");
  toast("Post published!");
  loadPosts(payload.section);
};

supabase.auth.onAuthStateChange(() => renderAuth());
await renderAuth();
await loadPosts("education");
await loadPosts("relaxation");