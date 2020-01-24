import mongoose from "mongoose";
import Counter from "./counter";

export interface RoomModel extends mongoose.Document {
  id: number;
  contestId: number;
  available: boolean;
  teams: number[];
  ip: string;
  port: number;
  createdAt: Date;
  createdBy: number;
  updatedAt: Date;
  updatedBy: number;
}

const roomSchema = new mongoose.Schema<RoomModel>(
  {
    id: { type: Number, unique: true }, // use auto-increment id, instead of _id generated by database
    contestId: { type: Number, required: true },
    available: { type: Boolean, default: true },
    teams: { type: [Number], required: true },
    ip: {
      type: String,
      required: true,
      validate: /((^\s*((([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5]))\s*$)|(^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*$))/
    },
    port: {
      type: Number,
      required: true,
      min: 0,
      max: 65535
    },
    createdAt: { type: Date, default: Date.now },
    createdBy: Number,
    updatedAt: { type: Date, default: Date.now },
    updatedBy: Number
  },
  {
    collection: "rooms"
  }
);

roomSchema.pre<RoomModel>("save", function(next) {
  Counter.findByIdAndUpdate(
    "room",
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

export default mongoose.model<RoomModel>("Room", roomSchema);
