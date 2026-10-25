
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import webpush from "web-push";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
}));
app.use(express.json());

if (
  !process.env.VAPID_PUBLIC_KEY ||
  !process.env.VAPID_PRIVATE_KEY ||
  !process.env.VAPID_SUBJECT
) {
  throw new Error("Configure your VAPID keys and subject in .env");
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Persistent local database
const db = new Database("todo.db");

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    due_date TEXT,
    notified INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    subscription_json TEXT NOT NULL
  );
`);

const insertTask = db.prepare(`
  INSERT INTO tasks (id, title, due_date)
  VALUES (?, ?, ?)
`);

const getTasks = db.prepare(`
  SELECT id, title, due_date AS dueDate, notified
  FROM tasks ORDER BY rowid DESC
`);

const getTask = db.prepare(`
  SELECT id, title, due_date AS dueDate, notified
  FROM tasks WHERE id = ?
`);

const deleteTask = db.prepare("DELETE FROM tasks WHERE id = ?");

const saveSubscription = db.prepare(`
  INSERT INTO subscriptions (endpoint, subscription_json)
  VALUES (?, ?)
  ON CONFLICT(endpoint) DO UPDATE SET
    subscription_json = excluded.subscription_json
`);

const getSubscriptions = db.prepare(`
  SELECT endpoint, subscription_json FROM subscriptions
`);

const deleteSubscription = db.prepare(`
  DELETE FROM subscriptions WHERE endpoint = ?
`);

const getDueTasks = db.prepare(`
  SELECT id, title, due_date AS dueDate
  FROM tasks
  WHERE due_date IS NOT NULL
    AND due_date <= ?
    AND notified = 0
`);

const markNotified = db.prepare(`
  UPDATE tasks SET notified = 1
  WHERE id = ? AND notified = 0
`);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Public key needed by the frontend to subscribe to push
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Save a browser's push subscription
app.post("/api/subscribe", (req, res) => {
  const subscription = req.body;

  if (
    !subscription?.endpoint ||
    !subscription?.keys?.p256dh ||
    !subscription?.keys?.auth
  ) {
    return res.status(400).json({
      error: "Invalid push subscription",
    });
  }

  saveSubscription.run(
    subscription.endpoint,
    JSON.stringify(subscription)
  );

  res.status(201).json({ ok: true });
});

// Get tasks
app.get("/api/tasks", (req, res) => {
  res.json(getTasks.all());
});

// Create task
app.post("/api/tasks", (req, res) => {
  const { title, dueDate = null } = req.body;

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "Task title is required" });
  }

  if (title.length > 300) {
    return res.status(400).json({ error: "Task title is too long" });
  }

  if (dueDate !== null) {
    if (
      typeof dueDate !== "string" ||
      !Number.isFinite(Date.parse(dueDate)) ||
      Date.parse(dueDate) <= Date.now()
    ) {
      return res.status(400).json({
        error: "Reminder must be a valid future date and time",
      });
    }
  }

  const task = {
    id: randomUUID(),
    title: title.trim(),
    dueDate,
    notified: 0,
  };

  insertTask.run(task.id, task.title, task.dueDate);

  res.status(201).json(task);
});

// Delete task; deleting it cancels its pending reminder
app.delete("/api/tasks/:id", (req, res) => {
  const result = deleteTask.run(req.params.id);

  if (!result.changes) {
    return res.status(404).json({ error: "Task not found" });
  }

  res.json({ ok: true });
});

// Send push notifications for due tasks
let checking = false;

async function checkReminders() {
  // Prevent overlapping checks
  if (checking) return;
  checking = true;

  try {
    const dueTasks = getDueTasks.all(new Date().toISOString());
    const subscriptions = getSubscriptions.all();

    for (const task of dueTasks) {
      // Mark as handled once, so multiple scheduler runs do not repeat it.
      const claimed = markNotified.run(task.id);

      if (!claimed.changes) continue;

      const payload = JSON.stringify({
        title: "Task reminder",
        body: task.title,
        taskId: task.id,
        url: "/",
      });

      for (const row of subscriptions) {
        try {
          await webpush.sendNotification(
            JSON.parse(row.subscription_json),
            payload,
            { TTL: 3600 }
          );
        } catch (error) {
          console.error("Push delivery failed:", error.statusCode || error.message);

          if (error.statusCode === 404 || error.statusCode === 410) {
            deleteSubscription.run(row.endpoint);
          }
        }
      }
    }
  } catch (error) {
    console.error("Reminder scheduler error:", error);
  } finally {
    checking = false;
  }
}

app.listen(port, () => {
  console.log(`Todo backend running on http://localhost:${port}`);

  // Check due tasks every 15 seconds while this process is running.
  setInterval(checkReminders, 15_000);
  checkReminders();
});
