import bcrypt from "bcrypt";
import express from "express";
import jwt from "jsonwebtoken";
import Email from "../models/email";
import User from "../models/user";
// import recaptcha from "../middlewares/recaptcha";
import { sendEmail } from "../helpers/email";
import {
  verifyEmailTemplate,
  resetPasswordTemplate,
} from "../helpers/htmlTemplates";
import authenticate, { JwtUserPayload, JwtVerifyPayload } from "../middlewares/authenticate";
import { validateEmail, validatePassword } from "../helpers/validate";
import hasura from "../middlewares/hasura";
import type { MongoError } from "mongodb";
import { gql } from "graphql-request";
import { client } from "..";
const router = express.Router();
/*
`/user/login`：处理用户登录。根据`username/email/phone/student_no`从`hasura`的`users`表查找用户，并验证密码是否匹配，若验证成功，则返回`token`
- 请求方法：`POST`
- 请求：`body`中有`{user: string, password: string}`，其中`user`可以是`username/email/phone/student_no`中任一形式（可以先支持其中一两种），`password`是`bcrypt`加密后的。
- 响应：`data`中有`{token: string}`，为`JwtUserPayload`形式
*/
router.post("/login", async (req, res) => {
  const { user, password } = req.body;
  if (!user || !password) {
    return res
      .status(422)
      .send("422 Unprocessable Entity: Missing credentials");
  }
  try {
    let item: any = {};
    if (user.includes("@")){
      item = await client.request(
        gql`
          query MyQuery($email: String) {
            users(where: {email: {_eq: $email}}) {
              password
              id
              role
              uuid
            }
          }
        `,
        {
          email: user
        }
      );
    }
    if (!item) {
      return res.status(404).send("404 Not Found: User does not exist");
    }
    item = item.users[0];
    // console.log(JSON.stringify(item));
    const valid = await bcrypt.compare(password, item.password);
    if (!valid) {
      console.log("password wrong")
      return res.status(401).end();
    }
    const payload: JwtUserPayload = {
      uuid: item.uuid,
      role: item.role,
      _id: item.id,
      "https://hasura.io/jwt/claims": {
        "x-hasura-allowed-roles": [item.role],
        "x-hasura-default-role": item.role,
        "x-hasura-user-id": item.id,
      },
    };
    const token = jwt.sign(payload, process.env.SECRET!, {
      expiresIn: "24h",
    });
    return res
      .status(200)
      .json({ token });
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
});
/*
`/user/verify`：发送验证码。向提供的`email/phone`发送验证码（不需要验证是否在`users`表中），同时返回一个包含`hash`之后的验证码的、生存时间更短的`token`
- 请求方法：`POST`
- 请求：`body`中有`{email: string}`或`{phone: string}`
- 响应：`data`中有`{token: string}`，为`JwtVerifyPayload`形式
- 备注：需思考如何防止高频请求（前端会有倒计时，但不够）
*/
router.post("/verify", async(req, res) => {
  const { email, phone } = req.body;
  if (!email && !phone) {
    return res.status(422).send("422 Unprocessable Entity: Missing email or phone");
  }
  // 生成6位验证码
  const verificationCode = Math.floor(100000 + Math.random() * 900000);
  console.log("verficationCode = " + verificationCode);
  const code = await bcrypt.hash(String(verificationCode), 10);
  const token = jwt.sign(
    {
      email,
      phone,
      code
    } as JwtVerifyPayload,
    process.env.SECRET!,
    {
      expiresIn: "10m",
    }
  );
  if (email) {
    try{
      await sendEmail(
        email,
        "验证您的邮箱",
        verifyEmailTemplate(verificationCode.toString())
      );
    } catch (err) {
      console.error(err);
      return res.status(500).send(err);
    }
  }
  else if (phone) {
    // wait to be implemented
  }
  res.status(200).json({token});
});
/*
`/user/register`：创建用户。先验证请求中的验证码与`verificationToken`中的是否一致，再根据`email/phone`和`password`在`hasura`的`users`表中插入新行，并返回`token`
- 请求方法：`POST`
- 请求：`body`中有`{password: string, verificationCode: string, verificationToken: string}`，`password`是明文，`verificationCode`是6位明文验证码，`verificationToken`是`/user/verify`返回的
- 响应：`data`中有`{token: string}`，为`JwtUserPayload`形式，初始`role`应为`user`
*/
router.post("/register", async(req, res) => {
  const { password, verificationCode, verificationToken } = req.body;
  if (!password || !verificationCode || !verificationToken) {
    return res.status(422).send("422 Unprocessable Entity: Missing credentials");
  }
  try {
    const decoded = jwt.verify(verificationToken, process.env.SECRET!) as JwtVerifyPayload;
    if (!decoded.email && !decoded.phone) {
      return res.status(422).send("422 Unprocessable Entity: Missing email or phone");
    }
    //查询数据库中是否已存在该用户的email或phone
    const userExist = await client.request(
      gql`
        query MyQuery($email: String, $phone: String) {
          users(where: {_or: {email: {_eq: $email}, phone: {_eq: $phone}}}) {
            uuid
          }
        }
      `,
      {
        email: decoded.email || "AvoidNull",
        phone: decoded.phone || "AvoidNull"
      }
    );
    if (userExist.users.length !== 0) {
      return res.status(409).send("409 Conflict: User already exists");
    }
    const valid = await bcrypt.compare(verificationCode, decoded.code);
    if (!valid) {
      return res.status(401).end();
    }
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);
    // graphql mutation, set role to user, password to password_hash, email to decoded.email, phone to decoded.phone
    const userInsert = await client.request(
      gql`
        mutation MyMutation($email: String, $phone: String, $password: String!) {
          insert_users_one(object: {email: $email, phone: $phone, password: $password, role: "user"}) {
            uuid
          }
        }
      `,
      {
        email: decoded.email,
        phone: decoded.phone,
        password: password_hash
      }
    );
    // graphql mutation, set id to uuid
    await client.request(
      gql`
        mutation MyMutation($uuid: uuid!, $id: String!) {
          update_users_by_pk(pk_columns: {uuid: $uuid}, _set: {id: $id}) {
            id
          }
        }
      `,
      {
        uuid: userInsert.insert_users_one.uuid,
        id: userInsert.insert_users_one.uuid
      }
    );
    // sign JwtUserPayload token
    const payload: JwtUserPayload = {
      uuid: userInsert.insert_users_one.uuid,
      role: "user",
      _id: userInsert.insert_users_one.uuid,
      "https://hasura.io/jwt/claims": {
        "x-hasura-allowed-roles": ["user"],
        "x-hasura-default-role": "user",
        "x-hasura-user-id": userInsert.insert_users_one.uuid,
      },
    };
    const token = jwt.sign(payload, process.env.SECRET!, {
      expiresIn: "24h",
    });
    return res.status(200).json({ token });
  } catch (err) {
    console.error(err);
    return res.status(500).send(err);
  }
});
// router.put("/delete", async(req, res) => {
//   try{
//     const authHeader = req.get("Authorization");
//     if (!authHeader) {
//       return res.status(401).send("401 Unauthorized: Missing token");
//     }
//     const token = authHeader.substring(7);
//     return jwt.verify(token, process.env.SECRET!, async (err, decoded) => {
//       if (err || !decoded) {
//         return res
//           .status(401)
//           .send("401 Unauthorized: Token expired or invalid");
//       }
//       const payload = decoded as JwtUserPayload;
//       const id = req.body._id, user = payload.email;
//       if(payload.role!=='root' && id !== payload._id){
//         return res.status(401).send()
//           .send(`401 Unauthorized: No authority to delete user ${user} or ID not match.`);
//       }
//       const num = await User.count({_id: id});
//       if(num !== 0){
//         if((await User.deleteOne({_id: id}))){
//           console.log("Delete Successfully.");
//           return res.status(200).send(`Delete user ${user} successfully.`);
//         }
//         else
//           return res.status(500).send("Error: Found multiple users in database.");
//       }
//       else
//         return res.status(501).send(`Error: User ${user} not found in database`);
//     });
//   } catch(err){
//     return res.send(err);
//   }
// })

// router.post("/", recaptcha, async (req, res) => {
router.post("/", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(422).send("422 Unprocessable Entity: Missing form data");
  }

  if (!validateEmail(email)) {
    return res.status(422).send("422 Unprocessable Entity: Invalid email");
  }

  if (!validatePassword(password)) {
    return res
      .status(422)
      .send("422 Unprocessable Entity: Password does not match pattern");
  }

  try {
    const saltRounds = 10;
    const hash = await bcrypt.hash(password, saltRounds);

    await new User({
      email,
      password: hash,
      role: "user",
    }).save();

    try {
      const token = jwt.sign(
        {
          email,
          type: "regular",
          action: "verifyEmail",
        },
        process.env.SECRET!,
        {
          expiresIn: "15m",
        }
      );
      await sendEmail(
        email,
        "验证您的邮箱",
        verifyEmailTemplate(
          `${process.env.EESAST_URL}/verify?type=regular&token=${token}`
        )
      );
    } catch (error) {
      // email verification can be requested later
      console.error(error);
    }

    return res.status(201).end();
  } catch (err) {
    console.error(err);

    if ((err as MongoError).code === 11000) {
      return res.status(409).send("409 Conflict: User already exists");
    } else {
      return res.status(500).end();
    }
  }
});

router.put("/", authenticate(), async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res
      .status(422)
      .send("422 Unprocessable Entity: Missing new password");
  }

  if (!validatePassword(password)) {
    return res
      .status(422)
      .send("422 Unprocessable Entity: Password does not match pattern");
  }

  try {
    const saltRounds = 10;
    const hash = await bcrypt.hash(password, saltRounds);

    const email = req.auth.user.email;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).send("404 Not Found: User does not exist");
    }

    user.update({ password: hash }, null, (err) => {
      if (err) {
        console.error(err);
        return res.status(500).end();
      } else {
        return res.status(204).end();
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
});



router.post("/verify", async (req, res) => {
  const { action, type } = req.body;

  if (action === "request") {
    // await new Promise((resolve) => recaptcha(req, res, resolve));

    if (type === "regular") {
      const { email } = req.body;

      try {
        const user = await User.findOne({ email });

        if (!user) {
          return res.status(404).send("404 Not Found: User does not exist");
        }

        const token = jwt.sign(
          {
            email,
            type: "regular",
            action: "verifyEmail",
          },
          process.env.SECRET!,
          {
            expiresIn: "15m",
          }
        );
        await sendEmail(
          email,
          "验证您的邮箱",
          verifyEmailTemplate(
            `${process.env.EESAST_URL}/verify?type=regular&token=${token}`
          )
        );
        return res.status(200).end();
      } catch (error) {
        console.error(error);
        return res.status(500).end();
      }
    } else if (type === "tsinghua") {
      // must provide token to know which account to verify for
      await new Promise((resolve) => authenticate()(req, res, resolve));

      try {
        const { tsinghuaEmail } = req.body;
        if (!validateEmail(tsinghuaEmail)) {
          return res
            .status(422)
            .send("422 Unprocessable Entity: Invalid Tsinghua email");
        }
        const token = jwt.sign(
          {
            email: req.auth.user.email,
            type: "tsinghua",
            tsinghuaEmail,
            action: "verifyEmail",
          },
          process.env.SECRET!,
          {
            expiresIn: "15m",
          }
        );
        await sendEmail(
          tsinghuaEmail,
          "验证您的清华邮箱",
          verifyEmailTemplate(
            `${process.env.EESAST_URL}/verify?type=tsinghua&token=${token}`
          )
        );
        return res.status(200).end();
      } catch (error) {
        console.error(error);
        return res.status(500).end();
      }
    } else {
      return res.status(422).send("422 Unprocessable Entity: Wrong type");
    }
  } else if (action === "fulfill") {
    const { token } = req.body;

    jwt.verify(token as string, process.env.SECRET!, async (err, decoded) => {
      if (err || !decoded) {
        return res
          .status(401)
          .send("401 Unauthorized: Token expired or invalid");
      }

      const payload = decoded as {
        email: string;
        type: string;
        tsinghuaEmail: string;
        action: string;
      };
      if (payload.action !== "verifyEmail") {
        return res
          .status(401)
          .send("401 Unauthorized: Token expired or invalid");
      }

      try {
        const user = await User.findOne({ email: payload.email });

        if (!user) {
          return res.status(404).send("404 Not Found: User does not exist");
        }

        if (type === "tsinghua") {
          if (user.role === "user") {
            const email = await Email.findOne({ email: payload.tsinghuaEmail });
            const role = email ? "EEsenior" : "student";

            try {
              user.update(
                { role, tsinghuaEmail: payload.tsinghuaEmail },
                null,
                (err) => {
                  if (err) {
                    console.error(err);
                    return res.status(500).end();
                  } else {
                    return res.status(200).end();
                  }
                }
              );
            } catch (e) {
              if ((e as MongoError).code === 11000) {
                return res
                  .status(409)
                  .send(
                    "409 Conflict: Tsinghua email has already been associated with another user"
                  );
              }
            }
          } else {
            return res.status(200).end();
          }
        } else if (type === "regular") {
          await client.request(
            gql`
              mutation InsertUser($_id: String!) {
                insert_user_one(object: {_id: $_id}) {
                  _id
                }
              }
            `,
            { _id: user._id }
          );

          user.update({ emailVerified: true }, null, (err) => {
            if (err) {
              console.error(err);
              return res.status(500).end();
            } else {
              return res.status(200).end();
            }
          });
        } else {
          return res.status(422).send("422 Unprocessable Entity: Wrong type");
        }
      } catch (err) {
        console.error(err);
        res.status(500).end();
      }
    });
  } else {
    return res.status(422).send("422 Unprocessable Entity: Wrong action");
  }
});

router.post("/reset", async (req, res) => {
  const { action } = req.body;

  if (action === "request") {
    // await new Promise((resolve) => recaptcha(req, res, resolve));

    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).send("404 Not Found: User does not exist");
    }

    const token = jwt.sign(
      {
        email,
        action: "resetPassword",
      },
      process.env.SECRET!,
      {
        expiresIn: "15m",
      }
    );
    await sendEmail(
      email,
      "重置您的密码",
      resetPasswordTemplate(`${process.env.EESAST_URL}/reset?token=${token}`)
    );
    return res.status(200).end();
  } else if (action === "fulfill") {
    const { token } = req.body;

    jwt.verify(token as string, process.env.SECRET!, async (err, decoded) => {
      if (err || !decoded) {
        return res
          .status(401)
          .send("401 Unauthorized: Token expired or invalid");
      }

      const payload = decoded as { email: string; action: string };
      if (payload.action !== "resetPassword") {
        return res
          .status(401)
          .send("401 Unauthorized: Token expired or invalid");
      }

      const email = payload.email;
      const { password } = req.body;

      if (!password) {
        return res
          .status(422)
          .send("422 Unprocessable Entity: Missing new password");
      }

      if (!validatePassword(password)) {
        return res
          .status(422)
          .send("422 Unprocessable Entity: Password does not match pattern");
      }

      try {
        const saltRounds = 10;
        const hash = await bcrypt.hash(password, saltRounds);

        const user = await User.findOne({ email });

        if (!user) {
          return res.status(404).send("404 Not Found: User does not exist");
        }

        user.update({ password: hash }, null, (err) => {
          if (err) {
            console.error(err);
            return res.status(500).end();
          } else {
            return res.status(204).end();
          }
        });
      } catch (err) {
        console.error(err);
        return res.status(500).end();
      }
    });
  } else {
    return res.status(422).send("422 Unprocessable Entity: Wrong action");
  }
});

router.post("/actions/user_by_role", hasura, async (req, res) => {
  const { role } = req.body.input;
  if (role !== "teacher") {
    return res.status(403).json({
      message: "403 Forbidden: Selection by this role not allowed",
      code: "403",
    });
  }

  try {
    const users = await User.find({ role });
    const usersByRole = await client.request(
      gql`
        query GetUsersByIds($ids: [String!]) {
          user(where: {_id: {_in: $ids}}) {
            _id
            name
            department
          }
        }
      `,
      { ids: users.map((u) => u._id) }
    )
    if (usersByRole?.user) {
      return res.status(200).json(usersByRole?.user);
    } else {
      console.error(usersByRole?.errors);
      return res.status(500).end();
    }
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
});

router.put("/role", authenticate(["root"]), async (req, res) => {
  const { _ids, role } = req.body;

  try {
    await User.updateMany(
      { _id: { $in: _ids } },
      { $set: { role: role } },
      (err: any) => {
        if (err) {
          console.error(err);
          return res.status(500).end();
        } else {
          return res.status(200).end();
        }
      }
    );
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
});

router.put("/role/:objectId", authenticate(["root"]), async (req, res) => {
  const { role } = req.body;

  try {
    await User.findByIdAndUpdate(
      req.params.objectId,
      { $set: { role: role } },
      (err) => {
        if (err) {
          console.error(err);
          return res.status(500).end();
        } else {
          return res.status(200).end();
        }
      }
    );
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
});

router.post("/details", authenticate(["root"]), async (req, res) => {
  const { tsinghuaEmail, email } = req.body;

  if (!tsinghuaEmail && !email) {
    return res.status(422).send("Missing email");
  }

  try {
    const user = tsinghuaEmail
      ? await User.findOne({ tsinghuaEmail: tsinghuaEmail }, "-__v -password")
      : await User.findOne({ email: email }, "-__v -password");

    return res.json(user);
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
});

export default router;
