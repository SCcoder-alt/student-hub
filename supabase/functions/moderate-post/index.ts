import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://sccoder-alt.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ allowed: false, message: "Method not allowed." }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ allowed: false, message: "Please sign in." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openAiKey = Deno.env.get("OPENAI_API_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey || !openAiKey) {
      console.error("Missing server configuration.");
      return json({ allowed: false, message: "Server configuration error." }, 500);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return json({ allowed: false, message: "Invalid login." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceKey);

    // Verify that this account is not currently suspended.
    const { data: ban, error: banError } = await adminClient
      .from("user_bans")
      .select("reason,expires_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (banError) {
      console.error("Ban lookup failed:", banError);
      return json({ allowed: false, message: "Could not verify account status." }, 503);
    }

    const banIsActive =
      !!ban &&
      (!ban.expires_at || new Date(ban.expires_at).getTime() > Date.now());

    if (banIsActive) {
      return json({
        allowed: false,
        message: `This account is suspended. ${ban.reason || "Contact a Student Hub administrator."}`,
      }, 403);
    }

    let body: {
      section?: string;
      title?: string;
      content?: string;
      image_path?: string | null;
    };

    try {
      body = await req.json();
    } catch {
      return json({ allowed: false, message: "Invalid request body." }, 400);
    }

    const section = body.section;
    const title = String(body.title || "").trim();
    const content = String(body.content || "").trim();
    const imagePath = body.image_path || null;

    if (
      !["education", "relaxation"].includes(section || "") ||
      !title ||
      !content ||
      title.length > 120 ||
      content.length > 10000
    ) {
      return json({ allowed: false, message: "Invalid post." }, 400);
    }

    // Only allow image objects stored in the signed-in user's own folder.
    let imageUrl: string | null = null;

    if (imagePath !== null) {
      if (
        typeof imagePath !== "string" ||
        !imagePath.startsWith(`${user.id}/`) ||
        imagePath.includes("..") ||
        imagePath.length > 500
      ) {
        return json({ allowed: false, message: "Invalid image path." }, 400);
      }

      const { data: imageFile, error: imageError } = await adminClient.storage
        .from("post_images")
        .download(imagePath);

      if (imageError || !imageFile) {
        console.error("Image retrieval failed:", imageError);
        return json({ allowed: false, message: "Could not retrieve uploaded image." }, 400);
      }

      const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
      if (!allowedTypes.includes(imageFile.type) || imageFile.size > 5 * 1024 * 1024) {
        return json({ allowed: false, message: "Unsupported image type or file too large." }, 400);
      }

      imageUrl = adminClient.storage
        .from("post_images")
        .getPublicUrl(imagePath).data.publicUrl;
    }

    // Moderate the post text and, when present, its attached image.
    const moderationInput: Array<Record<string, unknown>> = [
      { type: "text", text: `${title}\n\n${content}` }
    ];

    if (imageUrl) {
      moderationInput.push({
        type: "image_url",
        image_url: { url: imageUrl }
      });
    }

    const moderationResponse = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: moderationInput,
      }),
    });

    if (!moderationResponse.ok) {
      console.error("OpenAI moderation failed:", moderationResponse.status);
      return json({
        allowed: false,
        message: "AI moderation is temporarily unavailable. Please try again later."
      }, 503);
    }

    const moderationBody = await moderationResponse.json();
    const result = moderationBody?.results?.[0];

    if (!result || typeof result.flagged !== "boolean") {
      return json({ allowed: false, message: "Invalid moderation response." }, 503);
    }

    const status = result.flagged ? "pending_review" : "published";
    const moderation = {
      provider: "openai",
      model: moderationBody.model || "omni-moderation-latest",
      flagged: result.flagged,
      categories: result.categories || {},
      category_scores: result.category_scores || {},
    };

    const displayName =
      user.user_metadata?.display_name ||
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.email?.split("@")[0] ||
      "Student";

    const { error: insertError } = await adminClient
      .from("posts")
      .insert({
        author_id: user.id,
        author_name: String(displayName).slice(0, 120),
        section,
        title,
        content,
        image_path: imagePath,
        status,
        moderation,
      });

    if (insertError) {
      console.error("Post insert failed:", insertError);
      return json({ allowed: false, message: "Post could not be saved." }, 500);
    }

    return json({
      allowed: true,
      status,
      message: result.flagged
        ? "Your post was sent to the moderator review queue."
        : "Your post was published.",
    });
  } catch (error) {
    console.error("moderate-post failed:", error);
    return json({
      allowed: false,
      message: "Server error. Post was not submitted."
    }, 500);
  }
});
