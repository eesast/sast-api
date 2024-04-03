import express from "express";
import { gql } from "graphql-request";
import { client } from "..";
import { docker_queue } from "..";
import jwt from "jsonwebtoken";
// import { JwtUserPayload } from "../middlewares/authenticate";
import * as fs from "fs/promises";
import * as utils from "../helpers/utils";
import authenticate, { JwtArenaPayload } from "../middlewares/authenticate";
import { TeamLabelBind, ContestResult } from "../helpers/utils";
import * as hasura from "../helpers/hasura"
import { v4 as uuidv4 } from 'uuid';
import getSTS from "../helpers/sts";
import COS from "cos-nodejs-sdk-v5";
import fStream from 'fs';


const router = express.Router();


/**
 * @param token
 * @param {string} contest_name
 * @param {uuid} map_id
 * @param {TeamLabelBind[]} team_labels
 */

//// 鉴权。检查登录状态
//// 检查contest表中的arena_switch是否为true
//// 检查用户是否在队伍中，或者是管理员
//// 后端也要检查，限制一支队伍的开战频率。
//// 后端也要检查数据库上的代码编译状态和角色代码分配状态，都正常的情况下再继续下一步。


router.post("/create", authenticate(), async (req, res) => {
  const user_uuid = req.auth.user.uuid;
  const contest_name = req.body.contest_name;
  const map_id = req.body.map_id;
  const team_label_binds: TeamLabelBind[] = req.body.team_labels;

  console.log("user_uuid: ", user_uuid);
  console.log("contest_name: ", contest_name);
  console.log("map_id: ", map_id);
  console.log("team_labels: ", team_label_binds);
  if (!contest_name || !team_label_binds || !map_id || !user_uuid || team_label_binds.length < 2) {
    return res.status(422).send("422 Unprocessable Entity: Missing credentials");
  }

  const { team_ids, team_labels } = team_label_binds.reduce((acc, team_label_bind) => {
    acc.team_ids.push(team_label_bind.team_id);
    acc.team_labels.push(team_label_bind.label);
    return acc;
  }, { team_ids: [] as string[], team_labels: [] as string[] });
  console.log("team_ids: ", team_ids);
  console.log("team_labels: ", team_labels);
  if (new Set(team_labels).size !== team_labels.length) {
    return res.status(422).send("422 Unprocessable Entity: Duplicate team labels");
  }

  const contest_id = await hasura.get_contest_id(contest_name);
  console.log("contest_id: ", contest_id);
  if (!contest_id) {
    return res.status(400).send("400 Bad Request: Contest not found");
  }

  const arena_switch = await hasura.get_contest_settings(contest_id)?.arena_switch ?? false;
  console.log("arena_switch: ", arena_switch);
  if (!arena_switch) {
    return res.status(403).send("403 Forbidden: Arena is not open");
  }

  const is_manager = await hasura.get_maneger_from_user(user_uuid, contest_id);
  console.log("is_manager: ", is_manager);
  if (!is_manager) {
    const user_team_id = await hasura.get_team_from_user(user_uuid, contest_id);
    console.log("user_team_id: ", user_team_id);
    if (!user_team_id) {
      return res.status(403).send("403 Forbidden: User not in team");
    } else if (user_team_id !== team_ids[0]) {
      return res.status(403).send("403 Forbidden: User not in team");
    }
  }

  const active_rooms = hasura.count_room_team(contest_id, team_ids[0]);
  console.log("active_rooms: ", active_rooms);
  if (active_rooms > 6) {
    return res.status(423).send("423 Locked: Request arena too frequently");
  }

  const players_labels_promises = team_labels.map(team_label => hasura.get_players_label(contest_id, team_label));
  const players_labels: Array<Array<string>> = await Promise.all(players_labels_promises);
  console.log("players_labels: ", players_labels);
  if (players_labels.some(player_labels => !player_labels)) {
    return res.status(400).send("400 Bad Request: Players_label not found");
  }

  // const players_labels_length = players_labels.map(player_labels => player_labels.length);
  const player_labels_flat = players_labels.flat();
  const team_ids_flat = team_ids.flatMap((team_id, index) => Array(players_labels[index].length).fill(team_id));
  const team_labels_flat = team_labels.flatMap((team_label, index) => Array(players_labels[index].length).fill(team_label));


  const player_roles_flat: Array<string> = [], player_codes_flat: Array<string> = [];
  const players_details_promises = player_labels_flat.map((player_label, index) =>
    hasura.get_player_code(team_ids_flat[index], player_label));
  const players_details = await Promise.all(players_details_promises);
  players_details.forEach(player_detail => {
    player_roles_flat.push(player_detail.role);
    player_codes_flat.push(player_detail.code_id);
  });
  console.log("players_roles_flat: ", player_roles_flat);
  console.log("players_codes_flat: ", player_codes_flat);
  if (player_roles_flat.some(player_role => !player_role) || player_codes_flat.some(player_code => !player_code)) {
    return res.status(403).send("403 Forbidden: Team player not assigned");
  }

  const code_status_flat: Array<string> = [], code_languages_flat: Array<string> = [];
  const code_details_promises = player_codes_flat.map(player_code => hasura.get_compile_status(player_code));
  const code_details = await Promise.all(code_details_promises);
  code_details.forEach(code_detail => {
    code_status_flat.push(code_detail.compile_status);
    code_languages_flat.push(code_detail.language);
  });
  console.log("code_status_flat: ", code_status_flat);
  console.log("code_languages_flat: ", code_languages_flat);
  if (code_status_flat.some(status => status !== "Success" && status !== "No Need")) {
    return res.status(403).send("403 Forbidden: Team code not compiled");
  }
  if (code_languages_flat.some(language => language !== "py" && language !== "cpp")) {
    return res.status(403).send("403 Forbidden: Team code language not supported");
  }

  const base_directory = await utils.get_base_directory();
  const temp_dir_name = uuidv4();
  await fs.mkdir(`${base_directory}/${contest_name}/arena/${temp_dir_name}`, { recursive: true });
  console.log("temp_dir_name: ", temp_dir_name);

  const files_exist_promises = player_codes_flat.map((player_code, index) => {
    const language = code_languages_flat[index];
    const code_file_name = language === "cpp" ? `${player_code}` : `${player_code}.py`;
    return fs.access(`${base_directory}/${contest_name}/code/${team_ids_flat[index]}/${code_file_name}`)
      .then(() => {
        return true;
      })
      .catch(() => {
        return false;
      });
  });
  const files_exist_flat = await Promise.all(files_exist_promises);
  console.log("files_exist: ", files_exist_flat);

  if (files_exist_flat.some(file_exist => !file_exist)) {
    const cos = await utils.initCOS();
    const config = await utils.getConfig();
    const download_promises = player_codes_flat.map((player_code, index) => {
      if (files_exist_flat[index]) {
        return Promise.resolve(true);
      }
      const language = code_languages_flat[index];
      const code_file_name = language === "cpp" ? `${player_code}` : `${player_code}.py`;
      return utils.downloadObject(`${contest_name}/code/${team_ids_flat[index]}/${code_file_name}`,
        `${base_directory}/${contest_name}/code/${team_ids_flat[index]}/${code_file_name}`, cos, config);
    });
    const download_results_flat = await Promise.all(download_promises);
    console.log("download_results: ", download_results_flat);
    if (download_results_flat.some(result => !result)) {
      return res.status(500).send("500 Internal Server Error: Code download failed");
    }
  }

  const copy_promises = player_codes_flat.map((player_code, index) => {
    const language = code_languages_flat[index];
    const code_file_name = language === "cpp" ? `${player_code}` : `${player_code}.py`;
    return fs.copyFile(`${base_directory}/${contest_name}/code/${team_ids_flat[index]}/${code_file_name}`,
      `${base_directory}/${contest_name}/arena/${temp_dir_name}/${code_file_name}`);
  });
  await Promise.all(copy_promises);

  const room_id = hasura.insert_room(contest_id, "Waiting", map_id);
  console.log("room_id: ", room_id);
  if (!room_id) {
    return res.status(500).send("500 Internal Server Error: Room not created");
  }

  const players_labels_cum = players_labels.map(player_labels => player_labels.length).reduce((acc, val) => {
    acc.push(val + (acc.length > 0 ? acc[acc.length - 1] : 0));
    return acc;
  } , [] as number[]);
  console.log("players_labels_sum: ", players_labels_cum);
  const players_roles = players_labels_cum.map((player_labels_sum, index) => {
    return player_roles_flat.slice(index > 0 ? players_labels_cum[index - 1] : 0, player_labels_sum);
  });
  const players_codes = players_labels_cum.map((player_labels_sum, index) => {
    return player_codes_flat.slice(index > 0 ? players_labels_cum[index - 1] : 0, player_labels_sum);
  });
  console.log("players_roles: ", players_roles);
  console.log("players_codes: ", players_codes);

  const insert_room_teams_affected_rows = await hasura.insert_room_teams(room_id, team_ids, team_labels, players_roles, players_codes);
  if (insert_room_teams_affected_rows !== team_ids.length) {
    return res.status(500).send("500 Internal Server Error: Room teams not created");
  }

  await fs.rename(`${base_directory}/${contest_name}/arena/${temp_dir_name}`, `${base_directory}/${contest_name}/arena/${room_id}`);


});

/**
 * @param token
 * @param {uuid} contest_id
 * @param {uuid} room_id
 * @param {boolean} team_seq
 * @param {number} map
 * @param {number} exposed
 */

router.post("/", async (req, res) => {
  try {
    const contest_id = req.body.contest_id;
    const room_id = req.body.room_id;
    const team_seq = req.body.team_seq as boolean;
    const map = req.body.map as number;
    const exposed = req.body.exposed as number;
    const base_directory = await get_base_directory();
    const authHeader = req.get("Authorization");
    if (!authHeader) {
      return res.status(401).send("401 Unauthorized: Missing token");
    }
    const token = authHeader.substring(7);
    return jwt.verify(token, process.env.SECRET!, async (err, decoded) => {
      if (err || !decoded) {
        return res
          .status(401)
          .send("401 Unauthorized: Token expired or invalid");
      }
      const payload = decoded as JwtUserPayload;
      const user_uuid = payload.uuid;
      const contest_name = await get_contest_name(contest_id);
      try {
        //查询选手是否在房间里
        const if_in_room = await client.request(
          gql`
              query query_if_in_room($room_id: uuid!, $user_uuid: uuid!) {
                contest_room_team(where: {_and: {room_id: {_eq: $room_id}, contest_team: {_or: [{team_leader_uuid: {_eq: $user_uuid}}, {contest_team_members: {user_uuid: {_eq: $user_uuid}}}]}}}) {
                  team_id
                }
              }
            `,
          {
            room_id: room_id,
            user_uuid: user_uuid
          }
        );
        if (if_in_room.contest_room_team.length === 0)
          return res.status(400).send("permission denied: not in room");
        try {
          const current_team_id =
            if_in_room.contest_room_team[0].team_id;
          //查询参赛队伍
          const query_teams = await client.request(
            gql`
                query query_teams($room_id: uuid!) {
                  contest_room_team(where: {room_id: {_eq: $room_id}}) {
                    team_id
                  }
                }
              `,
            {
              room_id: room_id
            }
          );
          const teams = query_teams.contest_room_team;
          if (teams.length != 2) {
            res.status(400).send("队伍信息错误");
          }
          const team_withseq = ["", ""] as string[];
          team_withseq[Number(team_seq)] = current_team_id;
          team_withseq[1 - Number(team_seq)] =
            current_team_id == teams[0].team_id ? teams[1].team_id : teams[0].team_id;
          try {
            await fs.mkdir(`${base_directory}/${contest_name}/arena/${room_id}`, {
              recursive: true,
              mode: 0o775,
            });
          } catch (err) {
            return res.status(400).send("文件存储目录创建失败");
          }

          docker_queue.push({
            contest_id: contest_id,
            room_id: room_id,
            team_id_1: team_withseq[0],
            team_id_2: team_withseq[1],
            map: map,
            arenic: 1,
            exposed: exposed,
          });
          return res.status(200).json({ exposed: exposed });
        } catch (err) {
          return res.status(400).send(err);
        }
      } catch (err) {
        return res.status(400).send(err);
      }
    });
  } catch (err) {
    return res.status(400).send(err);
  }
});


export default router;
