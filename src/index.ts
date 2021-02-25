import Debug from "debug";
import dotenv from "dotenv";
import http from "http";
import mongoose from "mongoose";
import app from "./app";

// // Use for dev
// import path from "path";
// dotenv.config({
//   path: path.resolve(process.cwd(), ".env.local"),
// });
dotenv.config();
const debug = Debug("eesast-api");
const databaseUrl =
  process.env.NODE_ENV === "production" ? process.env.DATABASE : "localhost";

const normalizePort: (val: string) => number | boolean = (val) => {
  const portNo = parseInt(val, 10);
  if (portNo >= 0) {
    return portNo;
  }
  return false;
};

mongoose.connect(`mongodb://${databaseUrl}:27017/sast-api?authSource=admin`, {
  useNewUrlParser: true,
  useCreateIndex: true,
  useFindAndModify: false,
  useUnifiedTopology: true,
  user: process.env.DB_USER,
  pass: process.env.DB_PASS,
});

const db = mongoose.connection;

db.on("error", (error) => {
  debug("Database connection error: " + error);
  process.exit(1);
});
db.once("open", () => {
  debug("Database connected");
});

const port = normalizePort(process.env.PORT || "28888");
app.set("port", port);

const server = http.createServer(app);
server.listen(port);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.syscall !== "listen") {
    throw error;
  }

  const bind = typeof port === "string" ? "Pipe " + port : "Port " + port;

  switch (error.code) {
    case "EACCES":
      debug(bind + " requires elevated privileges");
      process.exit(1);
      break;
    case "EADDRINUSE":
      debug(bind + " is already in use");
      process.exit(1);
      break;
    default:
      throw error;
  }
});

server.on("listening", () => {
  const addr = server.address();
  const bind = typeof addr === "string" ? "pipe " + addr : "port " + addr!.port;
  debug("Listening on " + bind);
});
