import * as mongoose from "mongoose";
import Counter from "./counter";

export interface ICommentModel extends mongoose.Document {
  id: number;
  authorId: number;
  articleId: number;
  content: string;
  replyTo: number;
  likers: number[];
  createdAt: Date;
  createdBy: number;
  updatedAt: Date;
  updatedBy: number;
  isAlive: boolean;
}

/**
 * Comment schema
 */
const commentSchema = new mongoose.Schema(
  {
    id: { type: Number, unique: true }, // use auto-increment id, instead of _id generated by database
    authorId: { type: Number, required: true },
    articleId: { type: Number, required: true }, // article's id
    content: { type: String, required: true }, // markdown string
    replyTo: { type: Number, required: true }, // -1 means it is the parent，otherwise refers to its parent
    likers: [Number],
    createdAt: { type: Date, default: Date.now },
    createdBy: Number,
    updatedAt: { type: Date, default: Date.now },
    updatedBy: Number,
    isAlive: { type: Boolean, default: true }
  },
  {
    collection: "comments"
  }
);

/**
 * Enable auto-increment
 * DO NOT USE ARROW FUNCTION HERE
 * Problem of `this` scope
 */
commentSchema.pre("save", function(next) {
  Counter.findByIdAndUpdate(
    "comment",
    { $inc: { count: 1 } },
    { new: true, upsert: true },
    (err, counter: any) => {
      if (err) {
        return next(err);
      }
      this.id = counter.count;
      next();
    }
  );
});

const Comment = mongoose.model<ICommentModel>("Comment", commentSchema);
Comment.updateMany(
  { isAlive: { $exists: false } },
  { $set: { isAlive: true } },
  (err, data) => {
    if (err) console.log(err);
    if (data.nModified) console.log("comment", data);
  }
);

export default Comment;
