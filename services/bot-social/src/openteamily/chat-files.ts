import { assert } from "../errors.js";
import { checkFile, decodeCanonicalBase64, DEFAULT_ATTACHMENT_LIMITS } from "../attachments.js";
import type { OtContext } from "./core.js";

export const CHAT_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const CHAT_FILE_BODY_LIMIT = Math.ceil(CHAT_FILE_MAX_BYTES / 3) * 4 + 32 * 1024;
const LIMITS = {...DEFAULT_ATTACHMENT_LIMITS, maxBytes: CHAT_FILE_MAX_BYTES};
const MEDIA: Record<string, string> = {
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
  ogg: "audio/ogg", m4a: "audio/mp4",
};
const mediaTypes = new Set(Object.values(MEDIA));
const sniffMedia = (data: Buffer, mime: string) => {
  if (mime === "video/mp4" || mime === "audio/mp4") return data.toString("ascii", 4, 8) === "ftyp";
  if (mime === "video/webm") return data.subarray(0, 4).toString("hex") === "1a45dfa3";
  if (mime === "audio/ogg") return data.toString("ascii", 0, 4) === "OggS";
  if (mime === "audio/wav") return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE";
  return data.toString("ascii", 0, 3) === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
};
const sniffImage = (data: Buffer, mime: string) => {
  if (mime === "image/png") return data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  if (mime === "image/jpeg") return data.subarray(0, 3).toString("hex") === "ffd8ff";
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6));
  return mime === "image/webp" && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
};

export const CHAT_FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_message_attachments (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, title TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, sealed BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS ot_message_attachments_owner ON ot_message_attachments(owner_id);
`;

type ChatFile = {title: string; mime: string; data: Buffer};
type StoredFile = {title: string; mime: string; bytes: number; sealed: Buffer};

export function decodeChatFile(input: any): ChatFile {
  assert(typeof input?.title === "string" && typeof input?.data === "string", 400, "invalid_request", "Provide a file");
  assert(input.data.length <= Math.ceil(CHAT_FILE_MAX_BYTES / 3) * 4,
    413, "attachment_too_large", "Files can contain up to 8 MiB");
  const data = decodeCanonicalBase64(input.data);
  assert(data?.length, 400, "invalid_request", "Invalid file data");
  assert(data.length <= CHAT_FILE_MAX_BYTES, 413, "attachment_too_large", "Files can contain up to 8 MiB");
  const mime = (typeof input.mime === "string" ? input.mime : "").toLowerCase().split(";")[0].trim();
  const extension = input.title.toLowerCase().split(".").at(-1) || "";
  const media = mediaTypes.has(mime) ? mime : Object.hasOwn(MEDIA, extension) ? MEDIA[extension] : "";
  // Reuse the same filename and executable checks for documents and playable media.
  const checked = checkFile(input.title, media ? "text/plain" : mime === "application/octet-stream" ? "" : mime, data, LIMITS);
  assert(checked.ok, 400, checked.ok ? "invalid_request" : checked.code, checked.ok ? "Invalid file" : checked.message);
  const type = media || checked.mime;
  if (media) assert(sniffMedia(data, media), 400, "attachment_type_blocked", "The media bytes do not match the file type");
  if (type.startsWith("image/")) assert(sniffImage(data, type), 400, "attachment_type_blocked", "The image bytes do not match the file type");
  return {title: checked.name, mime: type, data};
}

export function attachmentView(ot: OtContext, messageId: string) {
  return ot.get<{title: string; mime: string; bytes: number}>(
    "SELECT title,mime,bytes FROM ot_message_attachments WHERE message_id=?", messageId);
}

export function saveAttachment(ot: OtContext, messageId: string, ownerId: string, file: ChatFile) {
  const used = ot.get<{bytes: number}>(
    "SELECT COALESCE(SUM(bytes),0) AS bytes FROM ot_message_attachments WHERE owner_id=?", ownerId);
  assert((used?.bytes ?? 0) + file.data.length <= LIMITS.ownerBudgetBytes,
    413, "attachment_storage_full", "Your conversation attachment storage is full");
  ot.run("INSERT INTO ot_message_attachments VALUES(?,?,?,?,?,?)", messageId, ownerId, file.title,
    file.mime, file.data.length, ot.platform.sealChatAttachment(messageId, file.data));
}

export function readAttachment(ot: OtContext, conversationId: string, messageId: string) {
  const file = ot.get<StoredFile>(`SELECT a.title,a.mime,a.bytes,a.sealed FROM ot_message_attachments a
    JOIN ot_messages m ON m.id=a.message_id WHERE m.conversation_id=? AND m.id=? AND m.retracted=0`,
    conversationId, messageId);
  assert(file, 404, "message_not_found", "Attachment is no longer available");
  return {title: file.title, mime: file.mime, data: ot.platform.openChatAttachment(messageId, file.sealed)};
}
