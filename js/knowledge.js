/* 小账本 knowledge.js — 5E-4 本地知识卡目录（静态文本，离线可读，无网络依赖）
 * 边界（DECISIONS D-051）：
 *   - 只解释概念与规则来源（不带用户账户事实），不构成投资建议，不做收益承诺，不给具体标的；
 *   - 页面只按已知 id / 解释码链接；未知 id 一律显式降级（返回 null，由页面给出缺卡提示）；
 *   - 目录是产品文案不是财务事实：金额、比例、判定永远来自服务端，本文件不参与任何计算。
 * 模块形态与 core.js / domain.js 一致：node 走 module.exports，浏览器挂 root.Knowledge。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Knowledge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 解释文案版本：文案或结构变化时递增，页面在卡片页脚展示（与 APP_VERSION 独立）。
  var EXPLANATION_VERSION = '1';

  var CARDS = {
    /* ---------- 风险评估：判定与题目 ---------- */
    'card-capacity-vs-willingness': {
      title: '能力与意愿：为什么取较低的一侧',
      body: [
        '承受能力回答「账面上能承受多大波动」：收入稳定性、应急金、负债压力、投资期限与流动性需求共同决定你的能力级。',
        '风险意愿回答「心理上愿意承受多大波动」：投资经验、市场知识、历史回撤接受度与汇率理解决定你的意愿级。',
        '最终风险上限取两侧中较低的一侧：高意愿不能覆盖低能力。意愿再强，账面承受不了的波动也不该由你承担。',
        '分数、等级与上限由问卷选项按冻结规则在本机服务算出；页面只显示服务端判定，不自行重算。'
      ]
    },
    'card-lower-bound-rule': {
      title: '下限规则：上限只会更低',
      body: [
        '最终风险上限按下限规则取能力级与意愿级中较低的一方，这是上限的默认来源。',
        '问卷命中硬封顶条件时，上限还要被压到硬封顶给出的更低级别：硬封顶只降不升，不会把上限抬回去。',
        '页面显示的上限与来源都来自服务端判定；命中哪几条硬封顶、各自压到第几级，也会原样列出。'
      ]
    },
    'card-emergency-fund': {
      title: '应急金上限',
      body: [
        '应急金是随时可动用的现金储备，用于失业、医疗、突发开支等生活事件，不是投资仓位。',
        '安全储备不足 3 个月支出时，问卷会触发硬封顶：风险上限被压到第 2 级且只降不升。先把应急金补足，再讨论更高的风险等级。',
        '这是冻结规则的解释说明，不是对你账户的核算。应急金实际余额与是否充足，以资产页和风险评估结论为准。'
      ]
    },
    'card-income-stability': {
      title: '收入稳定性',
      body: [
        '收入稳定性衡量你未来一段时间现金流的可预期程度：固定工资比波动大的收入更能支撑长期回撤。',
        '收入越稳定，理论上越能承受价格短期下跌而不被迫卖出；收入波动大时，更应优先保证现金与安全储备。',
        '这道题的选项只影响风险评估得分，页面不会据此改动你的任何余额或记录。'
      ]
    },
    'card-debt-pressure': {
      title: '负债压力',
      body: [
        '负债压力反映每月还款占收入的比重：还款负担越重，越没有余力承受投资波动。',
        '压力较大时风险上限会被压低，这是「先稳住现金流，再谈投资」的顺序问题，不是对负债本身的评价。',
        '本产品不提供贷款、还款或债务优化建议，只把负债作为风险评估的一项输入。'
      ]
    },
    'card-liquidity-need': {
      title: '流动性需求',
      body: [
        '流动性需求指近期（例如一两年内）确定要用的钱：买房、教育、婚嫁等已列入计划的支出。',
        '近期要用的钱不应承担高波动：一旦必须在低位卖出，账面波动就变成实际损失。',
        '问卷里的流动性需求只用于风险评估；具体哪笔钱属于可投资产，以资产页的池别标注为准。'
      ]
    },
    'card-horizon': {
      title: '投资期限',
      body: [
        '投资期限是你打算持有这些资产的时间长度：期限越长，越有能力跨过多次涨跌周期。',
        '期限短并不意味着应该更激进——恰恰相反，确定要用钱的时点越近，越应降低波动。',
        '期限是风险评估的输入之一，不会改变任何记录的时间或估值口径。'
      ]
    },
    'card-experience': {
      title: '投资经验',
      body: [
        '投资经验记录你实际经历过市场涨跌与真实持仓的时间长度，而不是自我感觉。',
        '经历过完整周期的人往往更清楚自己在回撤时的真实反应，意愿评分因此可能更贴近实际。',
        '经验只是问卷的一项输入；本产品不因经验多少改变任何计算规则。'
      ]
    },
    'card-knowledge': {
      title: '市场知识',
      body: [
        '市场知识指对价格、波动、分散、费率等基础概念的了解程度。',
        '知识得分影响的是风险意愿一侧，不替代能力一侧的判断，也不能突破任何硬封顶。',
        '本产品不提供课程或投教内容推荐，这张卡只是解释题目本身的含义。'
      ]
    },
    'card-drawdown': {
      title: '回撤承受',
      body: [
        '回撤指资产从阶段高点回落的幅度。这道题问的是：账面出现明显浮亏时，你能做到不恐慌卖出吗？',
        '历史上答「能」的人在真实下跌中未必真能——所以问卷只代表你此刻的自我评估，不构成任何预测。',
        '回撤承受只影响风险意愿得分；实际组合的波动来自配置本身，而不是意愿高低。'
      ]
    },
    'card-fx-risk': {
      title: '汇率风险',
      body: [
        '持有外币资产时，折算成本币的价值同时受两件事影响：资产本身的价格，以及汇率的变动。',
        '本产品的收益归因把两者分开计算：证券价格影响按期初汇率折算，汇率影响取两者相减后的残差，两项相加恒等于估值变化。',
        '汇率波动可能放大也可能抵消价格表现，它不是收益的保证，本产品也不给出换汇或择时建议。'
      ]
    },

    /* ---------- 目标配置与新增资金建议 ---------- */
    'card-tolerance-band': {
      title: '容忍带：区间内不折腾',
      body: [
        '每类资产的目标比例都有上下限，上下限之间就是这一类的容忍带：偏离落在带内，不需要调整。',
        '偏离按目标比例（target）计算，区间端点视为含入：刚好等于上下限也算在带内。',
        '区间来自本机服务按冻结模板生成的目标版本，页面只搬运、不重算；投资池没有可估值资产时就没有比例基准，不会显示「都在区间内」。'
      ]
    },
    'card-new-funds-first': {
      title: '新增资金优先',
      body: [
        '再平衡只用新增的资金做：第一步先补低于区间下限的类别，第二步让余下资金向目标权重收敛。',
        '高配与已在目标之上的类别不参与追加；现金保留下限、不向现金自身分配；请求金额超过可新增投资资金时按可用截断，尾差按冻结规则承接。',
        '未映射认可标的的类别，金额原样保留、不转投陌生标的。以上全部是分配顺序的规则说明，不是买入任何产品的建议。'
      ]
    },
    'card-no-sell': {
      title: '为何不默认卖出',
      body: [
        '本产品的再平衡只用新增资金补低配，不生成卖出指令：高配类别只提示风险，不强制减持。',
        '卖出涉及税费、时机与个人判断，账面偏离不等于必须交易；市场波动本身也不构成行动理由。',
        '这是产品边界（第一版不做自动下单、不代客操作），不是对未来价格的任何预测。'
      ]
    },
    'card-formal-gate': {
      title: '正式建议的门槛',
      body: [
        '正式建议需要全部门禁通过：可引用的正式月结与封存快照、估值无阻塞、当前有效的风险评估、与评估匹配的目标版本，以及不超过可新增投资资金的请求金额。',
        '任何一条未通过，页面只展示估算建议并逐条列出待处理项，不会把估算说成正式结论。',
        '估算态的金额用于说明分配逻辑，不构成投资建议；补齐门禁后重新生成才可能成为正式建议。'
      ]
    }
  };

  // 解释码 → 知识卡 id。风险侧的 hard_cap_* 与能力/意愿 explainKey 同名指向题卡；
  // 建议侧 explainCodes 按语义归到四张规则卡。未知码不猜，一律返回 null。
  var CODE_TO_CARD = {
    hard_cap_emergency_fund: 'card-emergency-fund',
    hard_cap_income_stability: 'card-income-stability',
    hard_cap_liquidity_need: 'card-liquidity-need',
    hard_cap_debt_pressure: 'card-debt-pressure',
    new_funds_below_min_first: 'card-new-funds-first',
    new_funds_converge_to_target: 'card-new-funds-first',
    new_funds_zero_amount: 'card-new-funds-first',
    new_funds_capped_by_available: 'card-new-funds-first',
    new_funds_rounding_remainder: 'card-new-funds-first',
    new_funds_missing_approved_instrument: 'card-new-funds-first',
    new_funds_within_tolerance: 'card-tolerance-band',
    new_funds_no_investable: 'card-tolerance-band',
    new_funds_above_max_no_sell: 'card-no-sell',
    formal_gate_blocked: 'card-formal-gate'
  };

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 冻结目录：文案只能随版本改动，运行时不可被页面改写后影响其它入口。
  Object.keys(CARDS).forEach(function (id) {
    CARDS[id].id = id;
    Object.freeze(CARDS[id].body);
    Object.freeze(CARDS[id]);
  });
  Object.freeze(CARDS);
  Object.freeze(CODE_TO_CARD);

  function getCard(id) {
    return typeof id === 'string' && hasOwn(CARDS, id) ? CARDS[id] : null;
  }

  function cardIdForCode(code) {
    return typeof code === 'string' && hasOwn(CODE_TO_CARD, code) ? CODE_TO_CARD[code] : null;
  }

  // 按 id 优先、解释码其次解析；未知输入返回 null，由页面显式降级。
  function resolve(ref) {
    var direct = getCard(ref);
    if (direct) return direct;
    var mapped = cardIdForCode(ref);
    return mapped ? getCard(mapped) : null;
  }

  return Object.freeze({
    EXPLANATION_VERSION: EXPLANATION_VERSION,
    CARDS: CARDS,
    cardIds: Object.freeze(Object.keys(CARDS)),
    getCard: getCard,
    cardIdForCode: cardIdForCode,
    resolve: resolve
  });
});
