local async = require "util.async";
local http = require "net.http";
local json_encode = require "util.json".encode;
local jid_split = require "util.jid".split;
local hmac_sha1 = require "util.hashes".hmac_sha1;
local base64 = require "util.encodings".base64.encode;
local serialize = require "util.serialization".serialize;
local ltn12 = require("ltn12")
local os_time = os.time;

local muc_service = module:depends("muc");
local room_mt = muc_service.room_mt;

local api_key = module:get_option_string("talky_core_api_key", "");
local muc_affiliation_url = module:get_option_string("talky_core_muc_affiliation_url",  "");

local affiliation_cache = {};


local function fetch_role(room, jid)
    module:log("debug", "Testing room affiliation for user %s in room %s with URL %s", jid, room.jid, muc_affiliation_url);

    local cached = affiliation_cache[jid];
    if cached then
        module:log("debug", "Using cached affiliation: "..cached);
        return cached;
    end

    local userpart = tostring(os_time());
    local secret = base64(hmac_sha1(api_key, userpart, false))

    local body = json_encode({
        user_id = jid;
        room_id = room:get_talky_core_id();
    });

    local wait, done = async.waiter();
    local content, code, request, response;
    local ex = {
        method = "POST";
        headers = {
            Authorization = "Basic "..base64(userpart..":"..secret);
            ["Content-Type"] = "application/json";
            ["Content-Length"] = string.len(body);
        };
        body = body;
    };
    local function cb(content_, code_, request_, response_)
        content, code, request, response = content_, code_, request_, response_;
        done();
    end
    http.request(muc_affiliation_url, ex, cb);
    wait();

    if type(code) == "number" and code >= 200 and code <= 299 then
        module:log("debug", "HTTP API returned affiliation: "..content);
        affiliation_cache[jid] = content;
        return content;
    else
        module:log("debug", "HTTP API returned status code: "..code);
    end

    return nil, "Affiliation lookup failed: "..content;
end


room_mt.get_affiliation = function (room, jid)
    local role, err = fetch_role(room, jid);

    if err then
        module:log("error", err);
        return "none";
    end

    module:log("debug", "Using affiliation %s", role);

    return role;
end


module:hook("muc-occupant-left", function (event)
    local jid = event.occupant.bare_jid;
    affiliation_cache[jid] = nil;
end);


module:log("info", "Loaded mod_talky_core_muc_affiliations for %s", module.host);
