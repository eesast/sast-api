import * as mongoose from "mongoose";
import Counter from "./counter";

export interface IItemModel extends mongoose.Document {
  id: number;
  name: string;
  description?: string;
  total: number;
  left: number;
  createdAt: Date;
  createdBy: number;
  updatedAt: Date;
  updatedBy: number;
  isAlive: boolean;
}

/**
 * Item schema
 */
const itemSchema = new mongoose.Schema(
  {
    id: { type: Number, unique: true }, // use auto-increment id, instead of _id generated by database
    name: { type: String, required: true },
    description: String,
    total: { type: Number, required: true },
    left: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    createdBy: Number,
    updatedAt: { type: Date, default: Date.now },
    updatedBy: Number,
    isAlive: { type: Boolean, default: true }
  },
  {
    collection: "items"
  }
);

/**
 * Enable auto-increment
 * DO NOT USE ARROW FUNCTION HERE
 * Problem of `this` scope
 */
itemSchema.pre("save", function(next) {
  Counter.findByIdAndUpdate(
    "item",
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

const Item = mongoose.model<IItemModel>("Item", itemSchema);
Item.updateMany(
  { isAlive: { $exists: false } },
  { $set: { isAlive: true } },
  (err, data) => {
    if (err) console.log(err);
    if (data.nModified) console.log("item", data);
  }
);
export default Item;
