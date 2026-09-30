const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'../.github/workflows',name),'utf8');
test('close capture has seven independent starts and enough time for early wait',()=>{
 const s=read('close-snapshot.yml');
 for(const cron of ['27,57 4 * * 1-5','27,57 5 * * 1-5','20,25,30 6 * * 1-5'])assert.ok(s.includes(cron));
 assert.ok(s.includes('timeout-minutes: 180'));
 assert.ok(s.includes('group: close-snapshot-${{ github.run_id }}'));
 assert.ok(s.includes('cancel-in-progress: false'));
 assert.ok(s.includes('git restore --source=origin/main --worktree -- "$target"'));
 assert.ok(s.includes('if: always()'));
});
test('close rescue runs after collection and keeps retrying through local midnight',()=>{
 const s=read('close-score-rescue.yml');
 for(const text of ['35,45,55 6 * * 1-5','15 7 * * 1-5','*/30 7-15 * * 1-5','50 15 * * 1-5',"workflows: ['Close snapshot collector']",'types: [completed]','--score-only','node scripts/collect_close_result.cjs'])assert.ok(s.includes(text));
 assert.ok(s.includes("github.event.workflow_run.head_branch == 'main'"));
});
