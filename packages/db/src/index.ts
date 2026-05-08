export { createDatabase, applySchema } from "./connection.js";
export { createSessionStore, type SessionStore, type Session } from "./stores/session-store.js";
export {
  createMessageStore,
  type MessageStore,
  type Message,
  type NewMessage,
  type SearchResult,
} from "./stores/message-store.js";
export {
  sessions,
  messages,
  userProfiles,
  type NewSession,
  type UserProfile,
  type NewUserProfile,
} from "./schema.js";
