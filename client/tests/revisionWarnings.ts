import assert from 'node:assert/strict'
import { revisionWarnings } from '../src/utils/revisionWarnings'
const scope = { before: '他合上面板。引擎的低频共振再次传来，沉稳，持续，像', selected: '一颗巨大的心脏在飞船深处跳动。但这一次，林远舟听到的不再是安全感，而是无尽的寒意。', after: '', instruction: '精简重复表达' }
const escaped = '引擎的低频共振再次传来，沉稳，持续。当晚他又回到维修舱。' + '艾拉再次说明通讯器的来历。'.repeat(12)
assert.equal(revisionWarnings({...scope, replacement: escaped}).length, 2)
assert.deepEqual(revisionWarnings({...scope, replacement: '心跳。林远舟却绷紧了肩背。'}), [])
assert.deepEqual(revisionWarnings({...scope, instruction:'扩写', replacement:'新的动作描写。'.repeat(30)}), [])
assert(revisionWarnings({...scope, instruction:'润色', replacement:'新的动作描写。'.repeat(30)})[0].includes('可能超出'))
assert(revisionWarnings({...scope, instruction:'润色', before:'', after:scope.before, replacement:'引擎的低频共振再次传来，沉稳，持续。'})[0].includes('重复'))
assert.deepEqual(revisionWarnings({...scope, selected:'引擎的低频共振再次传来，沉稳，持续。', replacement:'引擎的低频共振再次传来，沉稳，持续。'}), [])
assert.deepEqual(revisionWarnings({...scope, selected:'甲 🛰 乙', replacement:'甲🛰乙'}), [])
console.log('✓ 精简变长、异常扩写、前后文重复告警；正常精简、授权扩写、选区内保留与空白/Unicode 计数通过')
