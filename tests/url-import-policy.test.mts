import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaUrl } from '../src/url-source.ts';
import { durationIsAllowed, importDurationLimit } from '../src/import-policy.ts';
import type { AppPrincipal } from '../src/identity.ts';

test('URL intake rejects non-public URL shapes before provider spending',()=>{
 for(const source of ['http://example.org/a.mp3','file:///tmp/a','https://u:p@example.org/a','https://127.0.0.1/a','https://2130706433/a','https://[::1]/a','https://example.internal/a','https://example.org:444/a','https://example.org/a#fragment','https://example.org/a\n']) assert.equal(parseMediaUrl(source),null,source);
 assert.equal(parseMediaUrl('https://media.example.org/a.mp3?token=opaque'),'https://media.example.org/a.mp3?token=opaque');
});

test('duration authority fails closed and checks actual finite positive seconds',()=>{
 const principal={subject:'fixture',displayName:'Fixture',course:null,courseId:null} as AppPrincipal;
 assert.equal(importDurationLimit(undefined),300);
 assert.equal(importDurationLimit({...principal,role:'guest',quotaClass:'guest'}),300);
 assert.equal(importDurationLimit({...principal,role:'student'}),900);
 assert.equal(importDurationLimit({...principal,role:'member'}),900);
 assert.equal(importDurationLimit({...principal,role:'instructor'}),900);
 assert.equal(importDurationLimit({...principal,role:'instructor',quotaClass:'guest'}),300);
 for(const value of [null,undefined,NaN,Infinity,0,-1,'299',301]) assert.equal(durationIsAllowed(value,300),false);
 assert.equal(durationIsAllowed(300,300),true);assert.equal(durationIsAllowed(900,900),true);assert.equal(durationIsAllowed(900.01,900),false);
});
