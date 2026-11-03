// Envoi d'e-mails sous Node : SMTP via nodemailer.
import nodemailer from "nodemailer";

export const transportConfigured = () => !!(process.env.SMTP_HOST && (process.env.SMTP_FROM || process.env.SMTP_USER));
export const createTransport = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "1",
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  connectionTimeout: 10_000, socketTimeout: 20_000,
});
