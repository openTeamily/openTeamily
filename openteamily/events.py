"""Authenticated bounded SSE invalidations, not message/token replay or a durable event log."""
import hashlib
import json
import sqlite3
from threading import Event, Lock
from time import monotonic
from weakref import finalize
from . import members, notifications

class StreamLimit(ValueError):
    pass

class Limits:
    def __init__(self):
        self.lock=Lock();self.users={}
    def acquire(self,uid):
        with self.lock:
            if sum(self.users.values())>=32 or self.users.get(uid,0)>=2:
                raise StreamLimit('Close another live-update tab before reconnecting')
            self.users[uid]=self.users.get(uid,0)+1
    def release(self,uid):
        with self.lock:
            remaining=self.users.get(uid,0)-1
            if remaining>0:self.users[uid]=remaining
            else:self.users.pop(uid,None)


def fingerprint(rows):
    value=hashlib.sha256()
    for row in rows:
        value.update(json.dumps(list(row),ensure_ascii=True,separators=(',',':')).encode()+b'\n')
    return value.hexdigest()


def snapshot(app,env,wid):
    # Read-only connections and a short progress budget: never keep a transaction,
    # write lock, cursor or connection across a network yield/sleep.
    with app.store.connect() as db:
        db.execute('PRAGMA query_only=ON');db.execute('PRAGMA busy_timeout=250');started=monotonic()
        db.set_progress_handler(lambda: int(monotonic()-started>.25),1000)
        db.execute('BEGIN')
        session=app.authenticated(db,env,int(app.clock()))
        uid=session['user_id']
        if members.load(db,wid,uid) is None:
            raise PermissionError('Workspace access revoked')
        social=fingerprint(db.execute('''SELECT c.id,c.updated,m.id,m.seq,COALESCE(s.revision,1),COALESCE(s.retracted,0),p.pinned
          FROM social_conversations c JOIN social_members a ON a.conversation_id=c.id AND a.user_id=?
          LEFT JOIN social_messages m ON m.conversation_id=c.id
          AND NOT EXISTS (SELECT 1 FROM social_message_deletions d WHERE d.message_id=m.id AND d.user_id=?)
          LEFT JOIN social_message_state s ON s.message_id=m.id
          LEFT JOIN social_preferences p ON p.conversation_id=c.id AND p.user_id=?
          WHERE c.workspace_id=? ORDER BY c.id,m.seq''',(uid,uid,uid,wid)))
        replies=fingerprint(db.execute('''SELECT r.id,r.status,r.updated,r.seq FROM social_agent_replies r
          JOIN social_members m ON m.conversation_id=r.conversation_id AND m.user_id=?
          WHERE r.workspace_id=? ORDER BY r.id''',(uid,wid)))
        docs=fingerprint(db.execute('SELECT id,revision FROM artifacts WHERE workspace_id=? ORDER BY id',(wid,)))
        notice=hashlib.sha256(json.dumps(notifications.listing(db,wid,uid),sort_keys=True).encode()).hexdigest()
        state={'social':hashlib.sha256((social+replies).encode()).hexdigest(),'artifacts':docs,'notifications':notice}
        digest=hashlib.sha256(json.dumps(state,sort_keys=True).encode()).hexdigest()
        return uid,digest,state


class EventStream:
    def __init__(self,limits,uid,read,initial,last_id='',wait=None,ticks=10):
        limits.acquire(uid)
        self._release=finalize(self,limits.release,uid)
        self.limits,self.uid,self.read=limits,uid,read
        self.initial,self.last_id=initial,last_id
        self.stop=Event();self.wait=wait or self.stop.wait
        self.ticks=ticks;self.closed=False;self.deadline=monotonic()+20;self.iterator=self.generate()
    def __iter__(self):return self
    def __next__(self):
        if self.closed:raise StopIteration
        try:return next(self.iterator)
        except BaseException:
            self.close();raise
    def close(self):
        if not self.closed:
            self.closed=True;self.stop.set();self._release();self.iterator.close()
    def generate(self):
        try:
            yield b'retry: 3000\n: connected\n\n'
            previous=self.last_id
            for tick in range(self.ticks):
                if monotonic()>=self.deadline:break
                try:
                    uid,digest,state=self.initial if tick==0 else self.read()
                    if uid!=self.uid:raise PermissionError('Session changed')
                except (PermissionError,) as exc:
                    yield b'event: revoked\ndata: {"code":"access_revoked"}\n\n';return
                except Exception as exc:
                    # A stream has already sent headers: emit a safe terminal error,
                    # never a traceback, private URL, session or database details.
                    revoked=getattr(exc,'status',None) in (401,403,404)
                    yield (b'event: revoked\ndata: {"code":"access_revoked"}\n\n' if revoked else b'event: unavailable\ndata: {"code":"temporarily_unavailable"}\n\n');return
                if digest!=previous:
                    yield ('id: '+digest+'\nevent: invalidate\ndata: '+json.dumps({'version':digest,'domains':state},separators=(',',':'))+'\n\n').encode()
                    previous=digest
                else:yield b': heartbeat\n\n'
                if tick+1<self.ticks and self.wait(max(0,min(2,self.deadline-monotonic()))):return
            # The bounded lease ended normally, not a transport failure.
            # Let the browser renew without showing a spurious disconnection.
            yield b'event: renew\ndata: {}\n\n'
        finally:
            # __next__/close own the reservation; generator finalization is safe too.
            if not self.closed:
                self.closed=True;self.stop.set();self._release()
