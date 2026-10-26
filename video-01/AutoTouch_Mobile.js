/**
 * AutoTouch 手机原生自动化脚本 (基于 Android 无障碍服务)
 * 适配：中国移动 / 澳门流量任务 (com.airvoy.airvoy)
 *
 * 本文件基于 AutoTouch_Mobile_fixed.js 复制，保留其全部已跑通逻辑，仅做以下改动
 * （原 AutoTouch_Mobile.js / AutoTouch_Mobile_fixed.js 均未改动）：
 *
 *   【修复】去掉“跑到 111 个就永久锁死”的逻辑：
 *     - 任务数只做“累计统计”，不设任何上限，可以一直跑、一直累加；
 *     - 新增「重置任务」按钮，需要把统计清零时手动点一下即可。
 *   【选卡规则】A/B 答案逐题“纯随机 + 出现次数动态平衡”，不含任何
 *     “前 N 道强制选 B”之类的规则；每次开始跑任务时，第一道题也直接进入随机平衡。
 *
 * 核心能力（沿用 fixed 版）：
 *   1. 智能模糊节点查找 findClickable：自动穿透匹配 text/desc，支持包含箭头(如“完成任务 ->”)与嵌套布局
 *   2. 防误触区域保护：中下半屏判定“继续”按钮，避开列表页顶部“继续”标题
 *   3. 启动前强制 auto.waitFor() 无障碍服务就绪检查
 *   4. 实时悬浮窗心跳扫描指示：彻底告别静默无响应，每秒显示监控焦点
 *   5. 全局 200ms 黄金极速响应与 0 次 AI 本地算术正则/音频保护
 */

// 1. 确保开启无障碍服务 (若未开启会自动跳转到系统无障碍设置页面等待开启)
if (auto.service == null) {
    toast("【AutoTouch】正在检查无障碍权限，请在列表中开启 AutoX 服务！");
    auto.waitFor();
}

// 确保悬浮窗权限
if (!floaty.checkPermission()) {
    toast("【AutoTouch】请开启悬浮窗权限以显示控制器！");
    floaty.requestPermission();
    exit();
}

// ==================== 1. 全局配置与参数 ====================
var CONFIG = {
    TARGET_PACKAGE: "com.airvoy.airvoy",
    FAST_TAP_DELAY: 200,          // 黄金就绪极速延迟 (200ms)
    SETTLE_DELAY: 600,            // 界面切换过渡等待 (ms)
    AUDIO_PAGE1_WAIT_MS: 7500,    // 声音题第 1 页最少完整收听时长 (7.5s)
    MAX_CONSECUTIVE_CHOICE: 4,    // 同一选项连续出现上限（绝不超过 4 次，防风控）
    MAX_IDLE_SECONDS: 60,         // 超 60 秒无点击操作自动暂停保护
};

// 本地持久化数据 (A/B 计数与历史记录)
var storage = storages.create("AutoTouch_Storage");
var aCount = storage.get("aCount", 0);
var bCount = storage.get("bCount", 0);
var lastChoice = storage.get("lastChoice", "");
var consecutiveCount = storage.get("consecutiveCount", 0);
var tasksCompleted = storage.get("tasksCompleted", 0);

// 运行状态机变量
var isRunning = false;
var currentCategory = "unknown";
var countedChoice = false;
var taskTie = null;
var audioPage1StartTime = 0;
var audioPlayedSet = {};
var audioShortestChoice = null;
var scanLoopCount = 0;
var lastActionTime = new Date().getTime();

// 【每次运行起始状态】把“连续选择计数”归零，保证新一次跑任务从第一道题开始就是纯随机平衡。
// 注意：A/B 累计次数（aCount / bCount）保留、不清零，长期“出现次数平衡”不受影响。
lastChoice = "";
consecutiveCount = 0;
storage.put("lastChoice", "");
storage.put("consecutiveCount", 0);

// ==================== 2. 悬浮窗控制台构建 ====================
var window = floaty.window(
    <card id="main_card" cardCornerRadius="16dp" cardElevation="8dp" cardBackgroundColor="#1E1E2E" margin="0" padding="0">
        <vertical padding="10dp" w="260dp">
            <horizontal id="drag_bar" gravity="center_vertical">
                <text text="⚡ AutoTouch (按住拖动)" textSize="12sp" textStyle="bold" textColor="#89B4FA" layout_weight="1"/>
                <text id="btn_close" text=" ✕ " textSize="14sp" textColor="#F38BA8" padding="4dp"/>
            </horizontal>
            
            <text id="txt_status" text="状态: 就绪待命" textSize="11sp" textColor="#CDD6F4" marginTop="4dp"/>
            <text id="txt_stats" text="已统计: 0 个 | A:0 B:0" textSize="11sp" textColor="#A6ADC8" marginTop="2dp"/>
            <text id="txt_log" text="已就绪，请在流量App中点开始" textSize="10sp" textColor="#6C7086" marginTop="2dp" maxLines="2" ellipsize="end"/>

            <horizontal marginTop="6dp" gravity="center">
                <button id="btn_toggle" text="▶ 开始挂机" textSize="12sp" textColor="#FFFFFF" bg="#22C55E" h="36dp" layout_weight="1" style="Widget.AppCompat.Button.Borderless"/>
                <button id="btn_reset_task" text="重置任务" textSize="10sp" textColor="#FFFFFF" bg="#89B4FA" h="36dp" w="58dp" marginLeft="4dp" style="Widget.AppCompat.Button.Borderless"/>
                <button id="btn_reset_ab" text="重置AB" textSize="10sp" textColor="#CDD6F4" bg="#313244" h="36dp" w="55dp" marginLeft="4dp" style="Widget.AppCompat.Button.Borderless"/>
            </horizontal>
        </vertical>
    </card>
);

window.setPosition(40, 260);

// 更新悬浮窗信息
function updateUI(status, logMsg) {
    ui.run(function() {
        if (!window) return;
        try {
            if (status) window.txt_status.setText("状态: " + status);
            var streakText = lastChoice ? " (连" + lastChoice + ":" + consecutiveCount + ")" : "";
            window.txt_stats.setText("已统计: " + tasksCompleted + " 个 | A:" + aCount + " B:" + bCount + streakText);
            if (logMsg) window.txt_log.setText(logMsg);
        } catch(e) {}
    });
}

// 悬浮窗顶部栏拖动支持 (绑定在 drag_bar，避免拦截按钮点击)
var touchStartX = 0, touchStartY = 0, winStartX = 0, winStartY = 0;
window.drag_bar.setOnTouchListener(function(view, event) {
    switch (event.getAction()) {
        case event.ACTION_DOWN:
            touchStartX = event.getRawX();
            touchStartY = event.getRawY();
            winStartX = window.getX();
            winStartY = window.getY();
            return true;
        case event.ACTION_MOVE:
            var dx = event.getRawX() - touchStartX;
            var dy = event.getRawY() - touchStartY;
            window.setPosition(winStartX + dx, winStartY + dy);
            return true;
    }
    return false;
});

// 悬浮窗按钮事件
window.btn_toggle.click(function() {
    isRunning = !isRunning;
    if (isRunning) {
        lastActionTime = new Date().getTime();
        window.btn_toggle.setText("⏸ 暂停挂机");
        window.btn_toggle.setBackgroundColor(colors.parseColor("#EAB308"));
        updateUI("运行中", "自动化挂机已启动，开始识别屏幕...");
    } else {
        window.btn_toggle.setText("▶ 开始挂机");
        window.btn_toggle.setBackgroundColor(colors.parseColor("#22C55E"));
        updateUI("已暂停", "自动化挂机已手动暂停");
    }
});

window.btn_reset_ab.click(function() {
    aCount = 0;
    bCount = 0;
    lastChoice = "";
    consecutiveCount = 0;
    storage.put("aCount", 0);
    storage.put("bCount", 0);
    storage.put("lastChoice", "");
    storage.put("consecutiveCount", 0);
    updateUI(null, "A/B 历史计数与防连击记录已重置");
});

// 「重置任务」按钮：只把任务累计统计清零，不触碰 A/B 数据
window.btn_reset_task.click(function() {
    // 挂机过程中忽略重置请求，避免误触导致累计任务数归零。
    if (isRunning) {
        updateUI("运行中无法重置", "请先暂停挂机，再点击“重置任务”清零");
        toast("【AutoTouch】请先暂停挂机，再重置任务数");
        return;
    }
    tasksCompleted = 0;
    storage.put("tasksCompleted", 0);
    updateUI("已重置任务数", "任务统计已清零，可重新开始累计");
});

window.btn_close.click(function() {
    isRunning = false;
    window.close();
    exit();
});

// ==================== 3. 核心工具与业务函数 ====================

// 智能查找控件：找到所有包含关键词的节点，优先返回屏幕下半部分的（真正的按钮）
// 避免误命中顶部标题/副标题中相同的文字
function findClickable(keyword) {
    var candidates = textContains(keyword).find();
    if (!candidates || candidates.size() === 0) {
        candidates = descContains(keyword).find();
    }
    if (!candidates || candidates.size() === 0) return null;
    
    var screenH = device.height || 2400;
    var bestNode = null;
    var bestY = -1;
    
    for (var i = 0; i < candidates.size(); i++) {
        var n = candidates.get(i);
        var nb = n.bounds();
        var ny = nb.centerY();
        // 优先选屏幕下半部分（y > 屏幕高度40%）的节点
        if (ny > screenH * 0.4 && ny > bestY) {
            bestY = ny;
            bestNode = n;
        }
    }
    
    // 如果下半部分没找到，退而取任意一个
    if (!bestNode && candidates.size() > 0) {
        bestNode = candidates.get(candidates.size() - 1);
    }
    
    return bestNode;
}

// 四重暴力点击：确保在任何 ColorOS / 一加手机上都能触发
function fastClick(node) {
    if (!node) return false;
    var b = node.bounds();
    var cx = b.centerX();
    var cy = b.centerY();
    
    // 过滤无效坐标
    if (cx <= 0 || cy <= 0) {
        updateUI("坐标异常", "bounds=(" + cx + "," + cy + ") 无效，跳过");
        return false;
    }

    // 调试：在悬浮窗显示即将点击的坐标
    updateUI(null, "▸ 点击坐标 (" + cx + ", " + cy + ")");

    sleep(CONFIG.FAST_TAP_DELAY);

    // ---- 第 1 层：无障碍原生 node.click() ----
    try {
        var cur = node;
        while (cur) {
            if (cur.isClickable()) {
                cur.click();
                log("点击方式1: node.click() on " + (cur.text() || cur.desc() || "container"));
                break;
            }
            cur = cur.parent();
        }
    } catch(e) { log("node.click 异常: " + e); }

    sleep(50);

    // ---- 第 2 层：gesture 手势模拟（最接近真人触控的 API）----
    try {
        gesture(150, [cx, cy], [cx, cy]);
        log("点击方式2: gesture(150ms) at (" + cx + "," + cy + ")");
    } catch(e) { log("gesture 异常: " + e); }

    sleep(50);

    // ---- 第 3 层：press 物理按压 ----
    try {
        press(cx, cy, 150);
        log("点击方式3: press(150ms) at (" + cx + "," + cy + ")");
    } catch(e) { log("press 异常: " + e); }

    sleep(50);

    // ---- 第 4 层：shell input tap（走 Linux 输入子系统，绕过所有无障碍限制）----
    try {
        var r = shell("input tap " + cx + " " + cy, false);
        log("点击方式4: shell input tap at (" + cx + "," + cy + ") exitCode=" + r.code);
    } catch(e) { log("shell tap 异常: " + e); }

    lastActionTime = new Date().getTime();
    sleep(CONFIG.SETTLE_DELAY);
    return true;
}

// 点击绝对坐标（四重）
function fastTapPoint(x, y) {
    sleep(CONFIG.FAST_TAP_DELAY);
    try { gesture(150, [x, y], [x, y]); } catch(e) {}
    sleep(50);
    try { press(x, y, 150); } catch(e) {}
    sleep(50);
    try { shell("input tap " + x + " " + y, false); } catch(e) {}
    lastActionTime = new Date().getTime();
    sleep(CONFIG.SETTLE_DELAY);
}

// A/B 选卡：逐题“纯随机 + 出现次数动态平衡”（无“前 N 道强制选 B”规则）
//   规则 1：默认 50/50 纯随机；当 A/B 累计次数相差 ≥2 时，把少的一方概率提到 75%，拉回平衡。
//   规则 2：防风控——同一选项最多连续 4 次，第 5 次强制翻转（避免出现 5 连相同）。
function pickBalancedChoice() {
    var choice = "";
    
    // 1. 严格防连击（硬性红线：同一选项连续出现已达 4 次，强制翻转！）
    if (consecutiveCount >= CONFIG.MAX_CONSECUTIVE_CHOICE) {
        choice = (lastChoice === "A") ? "B" : "A";
        log("【防风控翻转】已连续 " + consecutiveCount + " 次选 " + lastChoice + "，强制切换为 " + choice);
    } else {
        // 2. 动态随机平衡（长期比例逼近 50:50）：
        // 当某一边累计偏多 2 次以上时，动态提升另一边的出现概率，防止长期单边失衡
        var diff = aCount - bCount;
        var pA = 0.5; // 默认 50/50 纯随机
        if (diff >= 2) {
            pA = 0.25; // A 偏多，提升 B 概率至 75%
        } else if (diff <= -2) {
            pA = 0.75; // B 偏多，提升 A 概率至 75%
        }
        
        choice = (Math.random() < pA) ? "A" : "B";
    }

    // 3. 更新连选计数
    if (choice === lastChoice) {
        consecutiveCount++;
    } else {
        lastChoice = choice;
        consecutiveCount = 1;
    }
    
    // 4. 持久化记录
    storage.put("lastChoice", lastChoice);
    storage.put("consecutiveCount", consecutiveCount);
    
    return choice;
}

// ==================== 选项定位 / 点击 / 校验（修复“一直选B”）====================
var dumpedOnce = false;
var selectFailStreak = 0;

// 把当前屏幕的控件树导出到 /sdcard，用于确认 App 真实的控件结构
function dumpScreen(tag) {
    try {
        var all = boundsInside(0, 0, device.width, device.height).find();
        var lines = ["# " + tag + "  device=" + device.width + "x" + device.height + "  nodes=" + all.size()];
        for (var i = 0; i < all.size(); i++) {
            var n = all.get(i);
            var b = n.bounds();
            lines.push([
                n.className(),
                "text=" + (n.text() || ""),
                "desc=" + (n.desc() || ""),
                "[" + b.left + "," + b.top + "," + b.right + "," + b.bottom + "]",
                "click=" + n.clickable(), "sel=" + n.selected(),
                "chk=" + n.checked(), "en=" + n.enabled()
            ].join(" | "));
        }
        files.write("/sdcard/AutoTouch_dump_" + tag + ".txt", lines.join("\n"));
        log("已导出控件树: /sdcard/AutoTouch_dump_" + tag + ".txt");
    } catch (e) { log("dumpScreen 异常: " + e); }
}

// 按版面找“提交”上方的大卡片（按 上→下、左→右 排序，第 1 张 = A，第 2 张 = B）
function findOptionCards(limitBottom) {
    var W = device.width, H = device.height;
    var all = boundsInside(0, Math.round(H * 0.12), W, limitBottom).find();
    var cards = [];
    for (var i = 0; i < all.size(); i++) {
        var n = all.get(i), b = n.bounds();
        if (!n.clickable()) continue;
        if (b.width() < W * 0.35 || b.height() < H * 0.07 || b.height() > H * 0.45) continue;
        cards.push(n);
    }
    cards.sort(function (x, y) {
        var dy = x.bounds().top - y.bounds().top;
        return Math.abs(dy) > H * 0.03 ? dy : x.bounds().left - y.bounds().left;
    });
    var uniq = [];
    for (var j = 0; j < cards.length; j++) {
        var last = uniq.length ? uniq[uniq.length - 1].bounds() : null;
        var cur = cards[j].bounds();
        if (last && Math.abs(cur.top - last.top) < H * 0.03 && Math.abs(cur.left - last.left) < W * 0.03) continue;
        uniq.push(cards[j]);
    }
    return uniq;
}

// 定位选项 A / B：先按文字，再按版面；不再使用写死的屏幕比例坐标
function findOptionNode(label, submitNode) {
    var H = device.height;
    var limitBottom = submitNode ? submitNode.bounds().top : H;
    var other = (label === "A") ? "B" : "A";
    var re = new RegExp("[\\s\\S]*选项\\s*" + label + "[\\s\\S]*");
    var reOther = new RegExp("选项\\s*" + other);

    var list = textMatches(re).find();
    if (!list || list.size() === 0) list = descMatches(re).find();
    for (var i = 0; i < list.size(); i++) {
        var n = list.get(i);
        var t = n.text() || n.desc() || "";
        if (reOther.test(t)) continue;                 // 同时含 A、B 的整句标题，不是选项本身
        var cy = n.bounds().centerY();
        if (cy < H * 0.12 || cy > limitBottom) continue;
        return n;
    }

    var cards = findOptionCards(limitBottom);
    if (cards.length >= 2) return cards[label === "A" ? 0 : 1];
    return null;
}

function cardOf(node) {          // 最近的可点击祖先（含自身）
    var cur = node, d = 0;
    while (cur && d < 6) {
        if (cur.clickable()) return cur;
        cur = cur.parent(); d++;
    }
    return node;
}

function isChosen(node) {        // 只检查“这张卡片”范围内的 selected / checked
    var cur = node, d = 0;
    while (cur && d < 6) {
        try { if (cur.selected() || cur.checked()) return true; } catch (e) {}
        if (cur.clickable()) break;
        cur = cur.parent(); d++;
    }
    return false;
}

// 单次点击；失败重试时换方式，而不是在同一次里连点多下
function tapOption(node, method) {
    var b = node.bounds(), cx = b.centerX(), cy = b.centerY();
    if (method === 1) {
        var card = cardOf(node);
        if (!card.click()) click(cx, cy);
    } else if (method === 2) {
        click(cx, cy);
    } else {
        gesture(120, [cx, cy], [cx, cy]);
    }
    lastActionTime = new Date().getTime();
}

// 选中并校验：返回 "ok"(已确认) / "unknown"(App 不暴露选中状态，无法确认) / "fail"
function selectOptionVerified(choice, submitNode) {
    var other = (choice === "A") ? "B" : "A";
    var wasEnabled = true;
    try { wasEnabled = submitNode.enabled(); } catch (e) {}

    for (var attempt = 1; attempt <= 3; attempt++) {
        var node = findOptionNode(choice, submitNode);
        if (!node) {
            updateUI("找不到选项", "第 " + attempt + " 次未定位到选项 " + choice);
            sleep(500);
            continue;
        }
        var nb = node.bounds();
        log("选择 " + choice + " 第" + attempt + "次 方式" + attempt + " 控件=" + (node.text() || node.desc() || node.className()) +
            " 中心=(" + nb.centerX() + "," + nb.centerY() + ")");
        tapOption(node, attempt);
        sleep(500);

        var mine = findOptionNode(choice, submitNode);
        var oth = findOptionNode(other, submitNode);
        var mineOn = !!(mine && isChosen(mine));
        var othOn = !!(oth && isChosen(oth));
        if (mineOn && !othOn) return "ok";
        if (othOn && !mineOn) { log("点错了：当前选中的是 " + other + "，重试"); continue; }

        // 读不到选中状态：用“提交”按钮由灰变亮作旁证
        var nowEnabled = true;
        try { var s2 = findClickable("提交"); nowEnabled = s2 ? s2.enabled() : true; } catch (e) {}
        if (!wasEnabled && nowEnabled) return "ok";
        return "unknown";
    }
    return "fail";
}

// 解析算术题 (支持任意等号算式，全方位兼容各种破折号/减号)
function solveMathProblem() {
    var candNodes = textContains("=").find();
    if (!candNodes || candNodes.size() === 0) {
        candNodes = descContains("=").find();
    }
    if (!candNodes || candNodes.size() === 0) {
        candNodes = textMatches(/.*[\+\-\*x×÷/–—−－].*/).find();
    }

    for (var i = 0; i < candNodes.size(); i++) {
        var node = candNodes.get(i);
        var rawText = (node.text() || node.desc() || "");
        if (!rawText) continue;

        // 标准化所有减号、乘号、除号与空格
        var normalized = rawText
            .replace(/[–—−－\u2013\u2014\u2212\uff0d]/g, "-")
            .replace(/[xX×\u00d7]/g, "*")
            .replace(/[÷\u00f7]/g, "/")
            .replace(/[\s\u00a0]+/g, " ");

        var m = normalized.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)\s*=/);
        if (!m) {
            m = normalized.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
        }

        if (m) {
            var n1 = parseInt(m[1], 10);
            var op = m[2];
            var n2 = parseInt(m[3], 10);
            var ans = null;
            if (op === "+") ans = n1 + n2;
            else if (op === "-") ans = n1 - n2;
            else if (op === "*") ans = n1 * n2;
            else if (op === "/") ans = Math.floor(n1 / n2);

            if (ans !== null) {
                return { expr: m[0], result: ans };
            }
        }
    }
    return null;
}

// 文本相似度比对 (用于听力题选项匹配)
function calcSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    var s1 = str1.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "");
    var s2 = str2.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "");
    if (!s1 || !s2) return 0;
    
    var set1 = {}, set2 = {};
    for (var i = 0; i < s1.length; i++) set1[s1[i]] = true;
    for (var j = 0; j < s2.length; j++) set2[s2[j]] = true;
    
    var inter = 0;
    for (var k in set1) {
        if (set2[k]) inter++;
    }
    var union = Object.keys(set1).length + Object.keys(set2).length - inter;
    var jaccard = union > 0 ? inter / union : 0;
    var subBonus = (s1.indexOf(s2) !== -1 || s2.indexOf(s1) !== -1) ? 0.3 : 0;
    return jaccard + subBonus;
}

// ==================== 4. 主自动化状态机驱动循环 ====================

threads.start(function() {
    log("AutoTouch 自动化线程就绪。");
    
    while (true) {
        if (!isRunning) {
            sleep(500);
            continue;
        }

        // 超时无操作保护：超过 60 秒无成功点击操作，自动暂停挂机保护
        var idleSeconds = (new Date().getTime() - lastActionTime) / 1000;
        if (idleSeconds >= CONFIG.MAX_IDLE_SECONDS) {
            isRunning = false;
            ui.run(function() {
                if (!window) return;
                window.btn_toggle.setText("▶ 开始挂机");
                window.btn_toggle.setBackgroundColor(colors.parseColor("#22C55E"));
            });
            updateUI("超时自动暂停", "超 60 秒无点击操作，已自动暂停挂机保护");
            toast("【AutoTouch】已自动暂停：超时 60s 无点击");
            sleep(1000);
            continue;
        }

        // 说明：任务数不做任何上限限制，只做累计统计；需要清零请点悬浮窗「重置任务」按钮。

        try {
            scanLoopCount++;

            // ----------------------------------------------------
            // 1. 完成结算页 (done)：有“已完成”或“恭喜”，且有“关闭”
            // ----------------------------------------------------
            var btnDoneClose = findClickable("关闭");
            if (btnDoneClose && (textContains("已完成").exists() || textContains("恭喜").exists())) {
                updateUI("任务完成", "检测到完成弹窗，200ms 秒关并计数 +1");
                tasksCompleted++;
                storage.put("tasksCompleted", tasksCompleted);
                countedChoice = false;
                currentCategory = "unknown";
                audioPage1StartTime = 0;
                audioPlayedSet = {};
                fastClick(btnDoneClose);
                continue;
            }

            // ----------------------------------------------------
            // 2. 失败结算页 (result_fail)：有“哎呀”或“答错”，且有“关闭”
            // ----------------------------------------------------
            if (btnDoneClose && (textContains("哎呀").exists() || textContains("答错").exists())) {
                updateUI("答题结算", "检测到失败弹窗，200ms 秒关并继续下一个");
                countedChoice = false;
                currentCategory = "unknown";
                audioPage1StartTime = 0;
                audioPlayedSet = {};
                fastClick(btnDoneClose);
                continue;
            }

            // ----------------------------------------------------
            // 3. 任务列表页 (task_list)：查找“完成任务”按钮
            // ----------------------------------------------------
            var btnDoTask = findClickable("完成任务");
            if (btnDoTask) {
                updateUI("任务列表", "检测到「完成任务」，200ms 秒进新题！");
                countedChoice = false;
                currentCategory = "unknown";
                taskTie = null;
                audioPage1StartTime = 0;
                audioPlayedSet = {};
                fastClick(btnDoTask);
                continue;
            }

            // ----------------------------------------------------
            // 4. 题型实时识别
            // ----------------------------------------------------
            if (textContains("哪段音频").exists() || textContains("收听两段音频").exists() || textContains("你听到的是哪句话").exists()) {
                currentCategory = "audio";
            } else if (textContains("哪张图片").exists()) {
                currentCategory = "image";
            } else if (textContains("哪个视频").exists() || textContains("观看两个视频").exists()) {
                currentCategory = "video";
            }

            // ----------------------------------------------------
            // 5. 快速检查算术题 (quick_check)：本地正则秒答
            // ----------------------------------------------------
            if (textContains("快速检查").exists() || textContains("正确答案").exists() || textContains("计算").exists() || textContains("?").exists()) {
                var mathRes = solveMathProblem();
                if (mathRes) {
                    var ansStr = mathRes.result.toString();
                    updateUI("算术秒答", "计算「" + mathRes.expr + " = " + ansStr + "」，本地秒选答案！");
                    
                    // 查找等于该答案的按钮
                    var optBtn = null;
                    // 1. 精确匹配
                    optBtn = text(ansStr).findOne(300) || desc(ansStr).findOne(300);
                    // 2. 正则精确数字匹配（防止带空格）
                    if (!optBtn) {
                        optBtn = textMatches(new RegExp("^\\s*" + ansStr + "\\s*$")).findOne(300) ||
                                 descMatches(new RegExp("^\\s*" + ansStr + "\\s*$")).findOne(300);
                    }
                    // 3. 遍历屏幕上所有选项按钮查找文字匹配
                    if (!optBtn) {
                        var allCandBtns = className("android.widget.Button").find();
                        for (var cbi = 0; cbi < allCandBtns.size(); cbi++) {
                            var bItem = allCandBtns.get(cbi);
                            var bTxt = (bItem.text() || bItem.desc() || "").trim();
                            if (bTxt === ansStr) {
                                optBtn = bItem;
                                break;
                            }
                        }
                    }

                    if (optBtn) {
                        countedChoice = false;
                        fastClick(optBtn);
                        sleep(CONFIG.SETTLE_DELAY);
                        continue;
                    }
                }
            }

            // ----------------------------------------------------
            // 6. 听力选择题 (listening_choice)：你听到的是哪句话？
            // ----------------------------------------------------
            if (textContains("你听到的是哪句话").exists()) {
                countedChoice = false;
                updateUI("听力题比对", "正在读取听力题候选选项...");
                var allBtns = className("android.widget.Button").find();
                var listenOpts = [];
                for (var bIdx = 0; bIdx < allBtns.size(); bIdx++) {
                    var bNode = allBtns.get(bIdx);
                    var bText = bNode.text() || bNode.desc();
                    if (bText && bText.length > 4 && bText.indexOf("继续") === -1 && bText.indexOf("提交") === -1 && bText.indexOf("选择正确答案") === -1) {
                        listenOpts.push(bNode);
                    }
                }

                if (listenOpts.length > 0) {
                    var matchedNode = null;
                    var maxScore = -1;
                    
                    var captions = className("android.widget.TextView").find();
                    var screenSubtitle = "";
                    for (var cIdx = 0; cIdx < captions.size(); cIdx++) {
                        var capText = captions.get(cIdx).text();
                        if (capText && capText.length > 8 && !textContains(capText).exists()) {
                            screenSubtitle += capText;
                        }
                    }

                    if (screenSubtitle) {
                        for (var o = 0; o < listenOpts.length; o++) {
                            var sc = calcSimilarity(screenSubtitle, listenOpts[o].text() || listenOpts[o].desc());
                            if (sc > maxScore) {
                                maxScore = sc;
                                matchedNode = listenOpts[o];
                            }
                        }
                    }

                    if (matchedNode && maxScore > 0.3) {
                        updateUI("听力精准秒选", "命中选项「" + (matchedNode.text() || "").substring(0, 12) + "...」");
                        fastClick(matchedNode);
                    } else {
                        var randPick = listenOpts[Math.floor(Math.random() * listenOpts.length)];
                        updateUI("听力兜底", "推进答题，选第 " + (listenOpts.indexOf(randPick) + 1) + " 项");
                        fastClick(randPick);
                    }
                    continue;
                }
            }

            // ----------------------------------------------------
            // 7. 提交页 (Page 5)：只要屏幕上有“提交”按钮，必定是最终提交答题页！
            // ----------------------------------------------------
            var btnSubmit = findClickable("提交");
            if (btnSubmit) {
                // 1. 本题尚未选卡：选卡 → 校验 → 校验通过才计数、才提交
                if (!countedChoice) {
                    if (!dumpedOnce) { dumpedOnce = true; dumpScreen("submit_page"); }

                    var prevLast = lastChoice, prevCons = consecutiveCount;
                    var targetChoice = pickBalancedChoice();
                    var selRes = selectOptionVerified(targetChoice, btnSubmit);

                    if (selRes === "fail") {
                        // 没选上：回滚连选记录，不提交、不计数，下一轮重试
                        lastChoice = prevLast;
                        consecutiveCount = prevCons;
                        storage.put("lastChoice", lastChoice);
                        storage.put("consecutiveCount", consecutiveCount);
                        selectFailStreak++;
                        dumpScreen("select_fail_" + targetChoice + "_" + selectFailStreak);
                        updateUI("选择失败", "未能选中选项 " + targetChoice + "（连续第 " + selectFailStreak + " 次），本轮不提交");
                        if (selectFailStreak >= 3) {
                            isRunning = false;
                            ui.run(function() {
                                if (!window) return;
                                window.btn_toggle.setText("▶ 开始挂机");
                                window.btn_toggle.setBackgroundColor(colors.parseColor("#22C55E"));
                            });
                            updateUI("已暂停", "连续 3 次选不中选项，请查看 /sdcard/AutoTouch_dump_*.txt");
                            toast("【AutoTouch】连续选不中选项，已暂停");
                        }
                        sleep(800);
                        continue;
                    }
                    selectFailStreak = 0;

                    if (targetChoice === "A") aCount++; else bCount++;
                    storage.put("aCount", aCount);
                    storage.put("bCount", bCount);
                    countedChoice = true;

                    updateUI("已选 " + targetChoice, "选 " + targetChoice + (selRes === "ok" ? " ✔已校验" : " ⚠无法校验") +
                        " | 累计 A:" + aCount + " B:" + bCount);
                    sleep(400);
                }

                // 2. 点击“提交”（重新取一次节点，避免引用过期）
                updateUI("点击提交", "已选选项锁定，点“提交”");
                fastClick(findClickable("提交") || btnSubmit);
                sleep(CONFIG.SETTLE_DELAY);
                continue;
            }

            // ----------------------------------------------------
            // 8. 观察页 / 音频第1页：“继续”按钮处理
            // (有“继续”按钮，且不在提交页)
            // ----------------------------------------------------
            var btnContinue = findClickable("继续");
            if (btnContinue && btnContinue.bounds().centerY() > device.height * 0.4) {
                countedChoice = false; // 离开提交页，重置选卡状态

                // A. 声音题第 1 页保护机制：智能识别最短音频，仅收听最短的那一段
                var isAudioPage1 = (currentCategory === "audio") || textContains("哪段音频").exists() || textContains("收听两段音频").exists() || textContains("音频听起来").exists();
                if (isAudioPage1) {
                    currentCategory = "audio";

                    // 1. 扫描屏幕上所有 0:xx 格式的时间标签
                    var allTexts = className("android.widget.TextView").find();
                    var durations = [];
                    for (var ti = 0; ti < allTexts.size(); ti++) {
                        var tt = allTexts.get(ti).text();
                        if (tt) {
                            var durMatch = tt.match(/(\d+):(\d{2})/);
                            if (durMatch) {
                                var secs = parseInt(durMatch[1], 10) * 60 + parseInt(durMatch[2], 10);
                                durations.push({ seconds: secs, y: allTexts.get(ti).bounds().centerY() });
                            }
                        }
                    }

                    // 区分选项 A 与 B，寻找最短音频
                    var shortestSec = 5;
                    var shortestY = Math.round(device.height * 0.35);
                    var shortestLabel = "A";
                    if (durations.length >= 2) {
                        durations.sort(function(a, b) { return a.y - b.y; });
                        if (durations[0].seconds <= durations[1].seconds) {
                            shortestSec = durations[0].seconds;
                            shortestY = durations[0].y;
                            shortestLabel = "A";
                        } else {
                            shortestSec = durations[1].seconds;
                            shortestY = durations[1].y;
                            shortestLabel = "B";
                        }
                    } else if (durations.length === 1) {
                        shortestSec = durations[0].seconds;
                        shortestY = durations[0].y;
                    }

                    // 2. 触发最短音频播放：紫色播放按钮位于屏幕左侧 x ≈ 16% 处，Y 坐标与时间标签水平对齐
                    if (audioPage1StartTime === 0) {
                        var playX = Math.round(device.width * 0.16);
                        updateUI("播放短音频", "智能收听短音频 " + shortestLabel + " (" + shortestSec + "s)，点击播放！");
                        fastTapPoint(playX, shortestY);
                        audioPage1StartTime = new Date().getTime();
                        CONFIG._dynamicWaitMs = (shortestSec + 1.5) * 1000;
                        sleep(800);
                        continue;
                    }

                    var waitTotal = CONFIG._dynamicWaitMs || 6500;
                    var elapsed = new Date().getTime() - audioPage1StartTime;
                    if (elapsed < waitTotal) {
                        var remainSec = Math.max(1, Math.round((waitTotal - elapsed) / 1000));
                        updateUI("短音频收听中", "仅收听最短音频(" + shortestSec + "s)，剩余 " + remainSec + "s 后自动继续...");
                        sleep(800);
                        continue;
                    } else {
                        updateUI("收听完毕", "最短音频播放完毕，200ms 秒点“继续”！");
                        audioPage1StartTime = 0;
                        CONFIG._dynamicWaitMs = null;
                        fastClick(btnContinue);
                        continue;
                    }
                }

                // B. 普通图片/视频观察页：若带倒计时则等待，无倒计时 200ms 秒点！
                var cText = btnContinue.text() || btnContinue.desc() || "";
                if (cText.indexOf("s") !== -1) {
                    updateUI("倒计时等待", "按钮倒计时中: " + cText);
                    sleep(500);
                    continue;
                } else {
                    updateUI("极速继续", "“继续”按钮就绪，200ms 秒点！");
                    fastClick(btnContinue);
                    continue;
                }
            }

            // 心跳日志：每隔几轮提示当前监控焦点，证明后台线程正常运行
            if (scanLoopCount % 5 === 0) {
                var pkg = currentPackage() || "";
                var isTarget = pkg.indexOf("airvoy") !== -1;
                updateUI("监控中", "等待可操作按钮... (" + (isTarget ? "流量App" : pkg) + ")");
            }

            sleep(300);

        } catch (e) {
            updateUI("运行异常", (e.message || String(e)).substring(0, 30));
            log("主循环异常捕获: " + e);
            sleep(1000);
        }
    }
});

// 防止主脚本提前退出
setInterval(function() {}, 10000);
