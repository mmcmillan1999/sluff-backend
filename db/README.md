# Lobby Chat Backend Endpoint

This folder contains an illustrative Express router for handling lobby chat messages. The actual backend implementation is not part of this repository.

## Database Table

Create a table called `lobby_chat_messages` with the following fields:

| Field      | Type      | Notes                       |
|------------|-----------|-----------------------------|
| `id`       | SERIAL    | Primary key                 |
| `user_id`  | INTEGER   | ID of the user sending text |
| `username` | TEXT      | Display name of sender      |
| `message`  | TEXT      | Chat content                |
| `created_at` | TIMESTAMP | Defaults to `NOW()`         |

## API Routes

- `GET /api/chat` – Returns an array of recent chat messages.
- `POST /api/chat` – Accepts `{ message }` and stores a new message. Returns the saved message object.

These endpoints are referenced by the front-end `LobbyChat` component.  