import json
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from uuid import uuid4

from sqlalchemy import URL, create_engine


TEAM_TIMEZONE = timezone(timedelta(hours=8))


def now():
    return datetime.now(TEAM_TIMEZONE)


def new_id(prefix):
    return f"{prefix}_{uuid4().hex}"


def money(value):
    return Decimal(str(value)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


class Store:
    def __init__(self, path):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(URL.create("sqlite", database=path))
        self.conn = self.engine.connect()
        self.conn.exec_driver_sql("PRAGMA journal_mode=WAL")
        schema = """
            CREATE TABLE IF NOT EXISTS records (
                collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
                PRIMARY KEY (collection, key)
            );
            CREATE TABLE IF NOT EXISTS messages (
                room TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL,
                PRIMARY KEY (room, seq)
            );
            CREATE TABLE IF NOT EXISTS charges (
                id INTEGER PRIMARY KEY, date TEXT NOT NULL, room TEXT NOT NULL,
                member TEXT NOT NULL, user TEXT NOT NULL, amount INTEGER NOT NULL,
                tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS charges_date ON charges(date);
        """
        for statement in schema.strip().rstrip(";").split(";"):
            self.conn.exec_driver_sql(statement)
        self.conn.commit()

    @contextmanager
    def transaction(self):
        # SQLAlchemy starts a logical transaction for reads too. Writes start
        # an explicit SQLite transaction so all related changes commit together.
        if self.conn.in_transaction():
            self.conn.rollback()
        with self.conn.begin():
            self.conn.exec_driver_sql("BEGIN IMMEDIATE")
            yield

    def close(self):
        self.conn.close()
        self.engine.dispose()

    def get(self, collection, key):
        row = self.conn.exec_driver_sql(
            "SELECT value FROM records WHERE collection=? AND key=?", (collection, key),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, collection):
        return [json.loads(row[0]) for row in self.conn.exec_driver_sql(
            "SELECT value FROM records WHERE collection=? ORDER BY rowid", (collection,),
        )]

    def put(self, collection, key, value):
        self.conn.exec_driver_sql(
            "INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value",
            (collection, key, json.dumps(value, ensure_ascii=False)),
        )

    def delete(self, collection, key):
        self.conn.exec_driver_sql("DELETE FROM records WHERE collection=? AND key=?", (collection, key))

    def messages(self, room, last_seq=0):
        return [json.loads(row[0]) for row in self.conn.exec_driver_sql(
            "SELECT value FROM messages WHERE room=? AND seq>? ORDER BY seq", (room, last_seq),
        )]

    def put_message(self, message):
        self.conn.exec_driver_sql(
            "INSERT INTO messages VALUES (?, ?, ?) ON CONFLICT(room,seq) DO UPDATE SET value=excluded.value",
            (message["room_id"], message["seq"], json.dumps(message, ensure_ascii=False)),
        )

    def delete_room(self, room):
        with self.transaction():
            for collection in ("rooms", "room_members", "room_states", "room_summaries"):
                self.delete(collection, room)
            self.conn.exec_driver_sql("DELETE FROM messages WHERE room=?", (room,))

    def charge(self, room, user, member, usage):
        amount = int(money(usage.cost_cny or 0) * 10000)
        self.conn.exec_driver_sql(
            "INSERT INTO charges(date,room,member,user,amount,tokens_in,tokens_out) VALUES (?,?,?,?,?,?,?)",
            (now().date().isoformat(), room, member, user, amount, usage.tokens_in, usage.tokens_out),
        )

    def charges(self, since=""):
        return self.conn.exec_driver_sql(
            "SELECT date, room, member, user, amount, tokens_in, tokens_out FROM charges WHERE date>=? ORDER BY date",
            (since,),
        ).fetchall()

    def monthly_cost(self, *, user=None, member=None):
        month = now().date().replace(day=1).isoformat()
        amount = self.conn.exec_driver_sql(
            "SELECT COALESCE(SUM(amount),0) FROM charges WHERE date>=? "
            "AND (? IS NULL OR user=?) AND (? IS NULL OR member=?)",
            (month, user, user, member, member),
        ).fetchone()[0]
        return Decimal(amount) / 10000
