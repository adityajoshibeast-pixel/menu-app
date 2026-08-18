const dns = require("dns");
const { MongoClient } = require("mongodb");
const { nanoid } = require("nanoid");

// Some Windows setups fail to resolve MongoDB Atlas's SRV DNS records even
// after the OS-level DNS is changed, because Node keeps using its own
// resolver. Forcing Google's DNS here fixes that without touching the OS.
// Only override DNS locally (some Windows setups fail to resolve Atlas's
// SRV records). Vercel's own network already resolves this correctly, and
// forcing an external DNS server there can make connections hang.
if (!process.env.VERCEL) {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
}
// Reuse one connection across warm serverless invocations instead of
// reconnecting on every request.
let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI environment variable is not set");
    }
    const client = new MongoClient(process.env.MONGODB_URI, {
  tls: true,
  serverSelectionTimeoutMS: 10000,
});
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db(process.env.MONGODB_DB || "menu_app");
}

const col = (name) => getDb().then((db) => db.collection(name));

const byOrder = (a, b) => a.order - b.order;
const nextOrder = (list) => (list.length ? Math.max(...list.map((x) => x.order)) + 1 : 0);

// Convert a Mongo doc (_id) into the shape the API/frontend expects (id).
function toPublic(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

// Swap the `order` field of `id` with its neighbour in `direction` (-1 up, +1 down)
// among `siblings` (docs already scoped to the same parent).
async function reorder(collection, siblings, id, direction) {
  const sorted = siblings.slice().sort(byOrder);
  const idx = sorted.findIndex((x) => x._id === id);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;
  const a = sorted[idx];
  const b = sorted[swapIdx];
  await collection.updateOne({ _id: a._id }, { $set: { order: b.order } });
  await collection.updateOne({ _id: b._id }, { $set: { order: a.order } });
}

module.exports = {
  // ---------- sections ----------
  async listSections() {
    const c = await col("sections");
    return (await c.find().toArray()).sort(byOrder).map(toPublic);
  },
  async createSection(title) {
    const c = await col("sections");
    const list = await c.find().toArray();
    const row = { _id: nanoid(), title, order: nextOrder(list) };
    await c.insertOne(row);
    return toPublic(row);
  },
  async updateSection(id, title) {
    const c = await col("sections");
    const res = await c.findOneAndUpdate(
      { _id: id },
      { $set: { title } },
      { returnDocument: "after" }
    );
    return toPublic(res?.value || res);
  },
  async deleteSection(id) {
    const sections = await col("sections");
    const subsections = await col("subsections");
    const items = await col("items");
    const childSubs = (await subsections.find({ section_id: id }).toArray()).map((s) => s._id);
    await items.deleteMany({ subsection_id: { $in: childSubs } });
    await subsections.deleteMany({ section_id: id });
    await sections.deleteOne({ _id: id });
  },
  async reorderSection(id, direction) {
    const c = await col("sections");
    const all = await c.find().toArray();
    await reorder(c, all, id, direction);
  },

  // ---------- subsections ----------
  async listSubsections(sectionId) {
    const c = await col("subsections");
    return (await c.find({ section_id: sectionId }).toArray()).sort(byOrder).map(toPublic);
  },
  async createSubsection(sectionId, title) {
    const c = await col("subsections");
    const siblings = await c.find({ section_id: sectionId }).toArray();
    const row = { _id: nanoid(), section_id: sectionId, title, order: nextOrder(siblings) };
    await c.insertOne(row);
    return toPublic(row);
  },
  async updateSubsection(id, title) {
    const c = await col("subsections");
    const res = await c.findOneAndUpdate(
      { _id: id },
      { $set: { title } },
      { returnDocument: "after" }
    );
    return toPublic(res?.value || res);
  },
  async deleteSubsection(id) {
    const subsections = await col("subsections");
    const items = await col("items");
    await items.deleteMany({ subsection_id: id });
    await subsections.deleteOne({ _id: id });
  },
  async reorderSubsection(id, direction) {
    const c = await col("subsections");
    const row = await c.findOne({ _id: id });
    if (!row) return;
    const siblings = await c.find({ section_id: row.section_id }).toArray();
    await reorder(c, siblings, id, direction);
  },

  // ---------- items ----------
  async listItems(subsectionId) {
    const c = await col("items");
    return (await c.find({ subsection_id: subsectionId }).toArray()).sort(byOrder).map(toPublic);
  },
  async getItem(id) {
    const c = await col("items");
    return toPublic(await c.findOne({ _id: id }));
  },
  async createItem(subsectionId, fields) {
    const c = await col("items");
    const siblings = await c.find({ subsection_id: subsectionId }).toArray();
    const row = { _id: nanoid(), subsection_id: subsectionId, order: nextOrder(siblings), ...fields };
    await c.insertOne(row);
    return toPublic(row);
  },
  async updateItem(id, fields) {
    const c = await col("items");
    const res = await c.findOneAndUpdate({ _id: id }, { $set: fields }, { returnDocument: "after" });
    return toPublic(res?.value || res);
  },
  async deleteItem(id) {
    const c = await col("items");
    const row = await c.findOne({ _id: id });
    await c.deleteOne({ _id: id });
    return toPublic(row);
  },
  async reorderItem(id, direction) {
    const c = await col("items");
    const row = await c.findOne({ _id: id });
    if (!row) return;
    const siblings = await c.find({ subsection_id: row.subsection_id }).toArray();
    await reorder(c, siblings, id, direction);
  },
};
