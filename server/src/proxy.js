// Which X-Forwarded-* headers to believe. Anyone can send these headers, so only take them from
// reverse proxies we know about: loopback (a proxy on the same machine) plus TRUSTED_PROXIES.

import net from "node:net";

function family(ip) {
	return net.isIPv6(ip) ? "ipv6" : "ipv4";
}

/** Strip the IPv4-in-IPv6 prefix Node gives IPv4 peers on dual-stack sockets. */
export function plainIp(ip) {
	ip = String(ip ?? "").trim();
	return ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

export class ProxyTrust {
	/**
	 * @param {object} opts
	 * @param {string[]} opts.trusted IP addresses or CIDR ranges, e.g. "172.17.0.0/16".
	 * @param {boolean} opts.trustAll Old TRUST_PROXY=true behaviour: believe the headers from anyone.
	 */
	constructor({ trusted = [], trustAll = false } = {}) {
		this.trustAll = trustAll;
		this.list = new net.BlockList();
		this.list.addSubnet("127.0.0.0", 8, "ipv4");
		this.list.addAddress("::1", "ipv6");
		for (const entry of trusted) {
			const [addr, bits] = entry.split("/");
			const ip = plainIp(addr);
			if (!net.isIP(ip)) throw new Error(`TRUSTED_PROXIES: "${entry}" isn't an IP address or CIDR range`);
			if (bits === undefined) this.list.addAddress(ip, family(ip));
			else {
				const prefix = Number(bits);
				const max = family(ip) === "ipv6" ? 128 : 32;
				if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`TRUSTED_PROXIES: bad prefix in "${entry}"`);
				this.list.addSubnet(ip, prefix, family(ip));
			}
		}
	}

	/** Is this address one of our proxies? */
	trusts(ip) {
		ip = plainIp(ip);
		if (!net.isIP(ip)) return false;
		return this.trustAll || this.list.check(ip, family(ip));
	}

	/** Did this request come straight from one of our proxies (so its X-Forwarded-Proto/Host count)? */
	fromProxy(req) {
		return this.trusts(req.socket?.remoteAddress);
	}

	/**
	 * The address of whoever really made this request. Walks X-Forwarded-For from the right (each proxy
	 * appends the address it saw) past our own proxies, so a client can't fake it by sending the header.
	 */
	clientIp(req) {
		let ip = plainIp(req.socket?.remoteAddress);
		if (!this.trusts(ip)) return ip;
		const hops = String(req.headers?.["x-forwarded-for"] ?? "").split(",").map(plainIp).filter(Boolean);
		while (hops.length) {
			const hop = hops.pop();
			if (!net.isIP(hop)) break;
			ip = hop;
			if (!this.trusts(hop) || this.trustAll) break;
		}
		return ip;
	}
}
