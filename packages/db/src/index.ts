export { createDatabase, applySchema } from "./connection.js";
export {
  createSessionStore,
  type SessionStore,
  type SessionStoreOptions,
  type Session,
} from "./stores/session-store.js";
export {
  createMessageStore,
  type MessageStore,
  type StoredUIMessage,
  type SearchResult,
} from "./stores/message-store.js";
export {
  sessions,
  messages,
  userProfiles,
  type NewSession,
  type MessageRow,
  type NewMessageRow,
  type UserProfile,
  type NewUserProfile,
} from "./schema.js";
