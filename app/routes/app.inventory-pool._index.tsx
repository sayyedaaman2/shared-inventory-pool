import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getPool } from "../utils/inventory-pool.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query InventoryPoolProducts {
        products(first: 50, sortKey: TITLE) {
          edges {
            node {
              id
              title
              status
              totalInventory
            }
          }
        }
      }`,
  );

  const result = await response.json();

  // Load pool status for each product
  const products = (result.data?.products?.edges ?? []).map(
    (edge: {
      node: {
        id: string;
        title: string;
        status: string;
        totalInventory: number | null;
      };
    }) => {
      const productId = edge.node.id;
      return {
        ...edge.node,
        hasPool: false,
      };
    },
  );

  // Build lookup map for O(1) product ID lookups
  const productMap = new Map(products.map((p) => [p.id, p]));

  // Fetch pool status for all products concurrently
  const poolPromises = products.map((product: { id: string }) =>
    getPool(product.id, product.id.split("/").pop() || "")
      .then((pool) => {
        if (pool && productMap.has(product.id)) {
          productMap.get(product.id).hasPool = true;
        }
        return product;
      })
  );
  await Promise.all(poolPromises);

  return {
    products,
  };
}

export default function InventoryPoolIndex() {
  const { products } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Shared Inventory Pools">
      <s-section heading="Select a product">
        {products.length === 0 ? (
          <s-text>No products found in your store.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {products.map((product: {
              id: string;
              title: string;
              status: string;
              totalInventory: number | null;
              hasPool: boolean;
            }) => (
              <s-box
                key={product.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-box>
                    <s-text>{product.title}</s-text>
                    <s-text>
                      Status: {product.status} · Inventory:{" "}
                      {product.totalInventory ?? 0}
                    </s-text>
                  </s-box>
                  {product.hasPool ? (
                    <>
                      <s-button tone="critical" href={`/app/inventory-pool/${encodeURIComponent(product.id)}`}>
                        View pool
                      </s-button>
                      <s-button href={`/app/inventory-pool/${encodeURIComponent(product.id)}`}>
                        Create pool
                      </s-button>
                    </>
                  ) : (
                    <s-button href={`/app/inventory-pool/${encodeURIComponent(product.id)}`}>
                      Create pool
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}