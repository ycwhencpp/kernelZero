import { authErrorResponse, requireUser } from "../../../../lib/auth";
import sharp from "sharp";
import {
  avatarStorageKey,
  createAvatarUrl,
  MAX_AVATAR_BYTES,
} from "../../../../lib/profile-avatar";
import { getSupabase, MEDIA_BUCKET } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

const MAX_MULTIPART_BYTES = MAX_AVATAR_BYTES + 64 * 1024;

type AvatarImage = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
};

const MAX_INPUT_PIXELS = 25_000_000;
const MAX_INPUT_DIMENSION = 16_384;
const MAX_OUTPUT_DIMENSION = 1_024;

function detectAvatarImage(bytes: Uint8Array): AvatarImage | null {
  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    return { contentType: "image/png" };
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.some(
      (value, index) =>
        index > 2 && value === 0xff && bytes[index + 1] === 0xd9,
    )
  ) {
    return { contentType: "image/jpeg" };
  }

  if (
    bytes.length >= 16 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 &&
    bytes[12] === 0x56 &&
    bytes[13] === 0x50 &&
    bytes[14] === 0x38 &&
    [0x20, 0x4c, 0x58].includes(bytes[15])
  ) {
    return { contentType: "image/webp" };
  }

  return null;
}

function unavailableResponse() {
  return Response.json(
    { error: "Profile picture storage is not configured." },
    { status: 503 },
  );
}

async function normalizeAvatarImage(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_INPUT_DIMENSION ||
      metadata.height > MAX_INPUT_DIMENSION ||
      (metadata.pages ?? 1) > 1 ||
      !["jpeg", "png", "webp"].includes(metadata.format ?? "")
    ) {
      return null;
    }

    const normalized = await image
      .rotate()
      .resize({
        width: MAX_OUTPUT_DIMENSION,
        height: MAX_OUTPUT_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      // A fresh encode strips EXIF, XMP, GPS, comments, and device metadata.
      .webp({ effort: 4, quality: 84 })
      .toBuffer();
    return normalized.byteLength <= MAX_AVATAR_BYTES
      ? new Uint8Array(normalized)
      : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
      return Response.json(
        { error: "Profile pictures must be 3 MB or smaller." },
        { status: 413 },
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json(
        { error: "Upload a JPEG, PNG, or WebP image." },
        { status: 400 },
      );
    }
    const avatar = form.get("avatar");
    if (!(avatar instanceof File) || avatar.size === 0) {
      return Response.json(
        { error: "Choose a JPEG, PNG, or WebP image." },
        { status: 400 },
      );
    }
    if (avatar.size > MAX_AVATAR_BYTES) {
      return Response.json(
        { error: "Profile pictures must be 3 MB or smaller." },
        { status: 413 },
      );
    }

    const bytes = new Uint8Array(await avatar.arrayBuffer());
    const detected = detectAvatarImage(bytes);
    if (!detected) {
      return Response.json(
        { error: "The file is not a valid JPEG, PNG, or WebP image." },
        { status: 415 },
      );
    }
    const normalizedBytes = await normalizeAvatarImage(bytes);
    if (!normalizedBytes) {
      return Response.json(
        {
          error:
            "The image could not be safely normalized. Use a non-animated image with reasonable dimensions.",
        },
        { status: 415 },
      );
    }

    const db = getSupabase();
    if (!db) return unavailableResponse();
    const key = avatarStorageKey(user.id);
    const { error: uploadError } = await db.storage
      .from(MEDIA_BUCKET)
      .upload(key, normalizedBytes, {
        cacheControl: "0",
        contentType: "image/webp",
        upsert: true,
      });
    if (uploadError) throw new Error(uploadError.message);

    const avatarUrl = createAvatarUrl(user.id);
    const { data: updatedProfile, error: updateError } = await db
      .from("profiles")
      .update({
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("auth_user_id", user.id)
      .select("id")
      .maybeSingle();
    if (updateError || !updatedProfile) {
      if (!user.avatarUrl) {
        await db.storage.from(MEDIA_BUCKET).remove([key]);
      }
      throw new Error(updateError?.message || "Unable to update your profile.");
    }

    return Response.json({ user: { ...user, avatarUrl } });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to upload profile picture.",
        },
        { status: 500 },
      )
    );
  }
}

export async function DELETE() {
  try {
    const user = await requireUser();
    const db = getSupabase();
    if (!db) return unavailableResponse();

    const { data: updatedProfile, error: updateError } = await db
      .from("profiles")
      .update({
        avatar_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq("auth_user_id", user.id)
      .select("id")
      .maybeSingle();
    if (updateError || !updatedProfile) {
      throw new Error(updateError?.message || "Unable to update your profile.");
    }

    const { error: removeError } = await db.storage
      .from(MEDIA_BUCKET)
      .remove([avatarStorageKey(user.id)]);
    if (removeError) {
      console.error(`[avatar] unable to remove stored profile image: ${removeError.message}`);
    }

    return Response.json({ user: { ...user, avatarUrl: null } });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to remove profile picture.",
        },
        { status: 500 },
      )
    );
  }
}
