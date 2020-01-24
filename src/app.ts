import cors from "cors";
import express from "express";
import logger from "morgan";
import path from "path";
import { OpenApiValidator } from "express-openapi-validator";
import errorHandler from "./middlewares/errorHandler";
import serverConfig from "./configs/server";
import announcementRouter from "./routes/announcements";
import articleRouter from "./routes/articles";
import commentRouter from "./routes/comments";
import contestRouter from "./routes/contests";
import staticRouter from "./routes/static";
import teamRouter from "./routes/teams";
import userRouter from "./routes/users";
import emailRouter from "./routes/emails";
import roomRouter from "./routes/rooms";

const app = express();

// enable header access in client
app.use(
  cors({
    exposedHeaders: "Location"
  })
);

app.use(logger("dev"));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use("/static", staticRouter);
app.use(
  "/static",
  express.static(serverConfig.staticFilePath, { fallthrough: false })
);
app.use("/v1", express.static(path.resolve(__dirname, "../docs")));

// install the Open-Api Validator
const apiSpec = path.resolve(__dirname, "../docs/swagger.yaml");
new OpenApiValidator({
  apiSpec
}).install(app);

app.use("/v1/articles", articleRouter);
app.use("/v1/comments", commentRouter);
app.use("/v1/contests", contestRouter);
app.use("/v1/users", userRouter);
app.use("/v1/teams", teamRouter);
app.use("/v1/announcements", announcementRouter);
app.use("/v1/emails", emailRouter);
app.use("/v1/rooms", roomRouter);

app.use(errorHandler);

export default app;
