import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ allowed:false, message:"Please sign in." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ allowed:false, message:"Invalid login." }, 401);

    const body = await req.json();
    const section = body.section;
    const title = String(body.title || "").trim();
    const content = String(body.content || "").trim();

    if (!["education","relaxation"].includes(section) || !title || !content ||
        title.length > 120 || content.length > 10000) {
      return json({ allowed:false, message:"Invalid post." }, 400);
    }

    /*
      AI MODERATION ADAPTER

      Set MODERATION_WEBHOOK_URL to a trusted server-side moderation endpoint.
      It receives {title, content, section} and MUST return JSON like:
      { "allowed": true/false, "reason": "...", "labels": [...] }

      Keep AI keys on the server only—never in app.js.

      If no moderation endpoint is configured, this function FAILS CLOSED:
      nothing is published without moderation.
    */
    const moderationUrl = Deno.env.get("MODERATION_WEBHOOK_URL");
    if (!moderationUrl) {
      return json({
        allowed:false,
        message:"Moderation is not configured yet. No post was published."
      }, 503);
    }

    const modResponse = await fetch(moderationUrl, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        ...(Deno.env.get("MODERATION_WEBHOOK_TOKEN")
          ? {"Authorization": `Bearer ${Deno.env.get("MODERATION_WEBHOOK_TOKEN")}`}
          : {})
      },
      body: JSON.stringify({ title, content, section })
    });

    if (!modResponse.ok) {
      return json({ allowed:false, message:"Moderation check failed. Post was not published." }, 503);
    }

    const moderation = await modResponse.json();
    if (!moderation.allowed) {
      return json({ allowed:false, message:"This post did not meet the community guidelines." }, 200);
    }

    const displayName =
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.email?.split("@")[0] ||
      "Student";

    const admin = createClient(supabaseUrl, serviceKey);
    const { error: insertError } = await admin.from("posts").insert({
      author_id: user.id,
      author_name: String(displayName).slice(0, 120),
      section, title, content,
      status:"published",
      moderation
    });

    if (insertError) throw insertError;
    return json({ allowed:true });
  } catch (err) {
    console.error(err);
    return json({ allowed:false, message:"Server error. Post was not published." }, 500);
  }
});
