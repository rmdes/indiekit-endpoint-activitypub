/**
 * MongoDB-backed KvStore adapter for Fedify.
 *
 * Implements Fedify's KvStore interface using a MongoDB collection.
 * Keys are string arrays (e.g. ["keypair", "rsa", "rick"]) — we serialize
 * them as a joined path string for MongoDB's _id field.
 */

/**
 * @implements {import("@fedify/fedify").KvStore}
 */
export class MongoKvStore {
  /** @param {import("mongodb").Collection} collection */
  constructor(collection) {
    this.collection = collection;
  }

  /**
   * Serialize a Fedify key (string[]) to a MongoDB document _id.
   * @param {string[]} key
   * @returns {string}
   */
  _serializeKey(key) {
    return key.join("/");
  }

  /**
   * @param {string[]} key
   * @returns {Promise<unknown>}
   */
  async get(key) {
    const doc = await this.collection.findOne({ _id: this._serializeKey(key) });
    return doc ? doc.value : undefined;
  }

  /**
   * @param {string[]} key
   * @param {unknown} value
   */
  async set(key, value) {
    const id = this._serializeKey(key);
    await this.collection.updateOne(
      { _id: id },
      { $set: { _id: id, value, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
  }

  /**
   * @param {string[]} key
   */
  async delete(key) {
    await this.collection.deleteOne({ _id: this._serializeKey(key) });
  }

  /**
   * List all entries whose key starts with the given prefix.
   * Required by Fedify 2.0's KvStore interface.
   *
   * @param {string[]} [prefix=[]]
   * @returns {AsyncIterable<{ key: string[], value: unknown }>}
   */
  async *list(prefix = []) {
    const prefixStr = this._serializeKey(prefix);
    const filter = prefixStr
      ? { _id: { $regex: `^${prefixStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } }
      : {};
    const cursor = this.collection.find(filter);
    for await (const doc of cursor) {
      yield {
        key: doc._id.split("/"),
        value: doc.value,
      };
    }
  }
}
