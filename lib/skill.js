/**
 * dsh-pocket — bundled skill provider.
 *
 * 把 `skills/dsh-web-url/` 作为随包技能注册到宿主的 `skills` 服务，让它跟着
 * 插件一起版本化、一起分发。候选按 bundled 规则：rank 600（项目/用户技能可
 * 同名覆盖）、resourceBase 指向包内目录（技能里的相对路径引用才可用）。
 *
 * 注册走 ctx.inject(['skills'], ...)，避免在冷启动时一次性 ctx.get('skills')
 * 取样不到而永久丢失注册（见 memory e3857c6b）。任何失败只记日志、不抛错。
 *
 * @module dsh-pocket/skill
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 随包技能目录，相对本文件上移一层到包根（磁盘绝对路径，字符串）。 */
const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

/** 技能目录名，必须与 SKILL.md frontmatter 的 name 一致。 */
const SKILL_NAME = 'dsh-web-url';

/** provider 名必须逐字等于本包 package.json 的 name。 */
const PROVIDER = '@restregular/dsh-pocket';

/** 对齐 @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK。 */
const RANK_BUNDLED = 600;

/**
 * 解析 SKILL.md 的 frontmatter 与正文。只用一份解析结果同时喂给目录和 get()，
 * 避免两处对同一文件判断不一致。本包自有的文件格式固定，无需完整 YAML 解析器。
 *
 * @param {string} raw
 * @returns {{ name: string, description: string, body: string } | undefined}
 */
function parseFrontmatter(raw) {
  const lines = raw.split(/\r?\n/u);
  if (lines[0] !== '---') return undefined;

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;

  const head = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n').trim();
  let name = '';
  let description = '';

  for (const line of head) {
    const nameMatch = /^name:\s*(\S+)\s*$/u.exec(line);
    if (nameMatch !== null) name = nameMatch[1];

    const quoted = /^description:\s*"(.*)"\s*$/u.exec(line);
    if (quoted !== null) {
      description = quoted[1].replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
    } else {
      const plain = /^description:\s*(.+?)\s*$/u.exec(line);
      if (plain !== null) description = plain[1];
    }
  }

  if (name.length === 0 || description.length === 0 || body.length === 0) return undefined;
  return { name, description, body };
}

/**
 * 把随包技能登记到宿主。失败只警告，不影响插件其它能力。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {(message: string) => void} warn
 */
export function registerBundledSkill(ctx, warn) {
  try {
    ctx.inject(['skills'], (scope) => {
      scope.effect(() => {
        const directory = join(SKILLS_DIR, SKILL_NAME);
        const path = join(directory, 'SKILL.md');
        let parsed;
        try {
          parsed = parseFrontmatter(readFileSync(path, 'utf8'));
        } catch (error) {
          warn(`pocket: 读取随包技能失败：${error?.message ?? error}`);
          return undefined;
        }
        if (parsed === undefined) {
          warn('pocket: 随包技能 SKILL.md 缺少合法 frontmatter');
          return undefined;
        }

        const { name, description, body } = parsed;
        const candidate = {
          name,
          description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER,
          source: 'bundled',
          rank: RANK_BUNDLED,
          resourceBase: { kind: 'directory', path: directory },
          locator: path,
          path,
        };

        try {
          return scope.skills.registerProvider(() => ({
            name: PROVIDER,
            list: () => Promise.resolve([candidate]),
            async get(winner) {
              const { rank, locator, ...summary } = winner;
              // 正文不缓存：重新读文件，包内编辑/热更新也能被看到。
              let content = body;
              try {
                const fresh = parseFrontmatter(readFileSync(locator, 'utf8'));
                if (fresh !== undefined) content = fresh.body;
              } catch {
                /* 保留构建时的正文 */
              }
              return { ...summary, content };
            },
          }));
        } catch (error) {
          warn(`pocket: 随包技能注册失败：${error?.message ?? error}`);
          return undefined;
        }
      }, 'pocket: bundled dsh-web-url skill');
    });
  } catch (error) {
    warn(`pocket: 随包技能注入失败：${error?.message ?? error}`);
  }
}
